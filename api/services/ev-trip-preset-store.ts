import { randomUUID } from 'node:crypto';
import { HttpError } from '../http-errors.ts';
import { loadData, saveData } from './data-store.ts';
import type { EvTripPreset } from '../types.ts';

export interface EvTripPresetInput {
  name?: unknown;
  usage_percent?: unknown;
}

const MAX_NAME_LENGTH = 40;

/** Case-insensitive so "Knokke" and "knokke" are the same destination, not two chips. */
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function parsePreset(input: EvTripPresetInput): { name: string; usage_percent: number } {
  // Typed rather than coerced: String({}) would persist a preset literally named
  // "[object Object]" instead of rejecting the payload.
  if (typeof input.name !== 'string') throw new HttpError(400, 'name must be a string');
  const name = input.name.trim();
  if (!name) throw new HttpError(400, 'name is required');
  if (name.length > MAX_NAME_LENGTH) throw new HttpError(400, `name must be at most ${MAX_NAME_LENGTH} characters`);

  const usage_percent = Number(input.usage_percent);
  if (!Number.isFinite(usage_percent) || usage_percent < 0 || usage_percent > 100) {
    throw new HttpError(400, 'usage_percent must be a number in [0, 100]');
  }
  return { name, usage_percent: Math.round(usage_percent) };
}

export async function loadEvTripPresets(): Promise<EvTripPreset[]> {
  const data = await loadData();
  return data.evTripPresets ?? [];
}

/**
 * Create the preset, or overwrite the percentage of the one already using that name. Saving
 * "Knokke" a second time is how the estimate is corrected — there is no separate edit step.
 */
export async function saveEvTripPreset(input: EvTripPresetInput) {
  const { name, usage_percent } = parsePreset(input);
  const data = await loadData();
  const presets = data.evTripPresets ?? [];

  const index = presets.findIndex(p => sameName(p.name, name));
  const preset: EvTripPreset = {
    id: index >= 0 ? presets[index].id : randomUUID(),
    name,
    usage_percent,
    updatedAt: new Date().toISOString(),
  };
  const next = index >= 0
    ? presets.map((p, i) => i === index ? preset : p)
    : [...presets, preset];

  await saveData({ ...data, evTripPresets: next });
  return { preset, presets: next };
}

export async function deleteEvTripPreset(id: string) {
  const data = await loadData();
  const presets = data.evTripPresets ?? [];
  const next = presets.filter(p => p.id !== id);
  if (next.length === presets.length) throw new HttpError(404, 'EV trip preset not found');

  await saveData({ ...data, evTripPresets: next });
  return { presets: next };
}
