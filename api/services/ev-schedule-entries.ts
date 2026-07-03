import { randomUUID } from 'node:crypto';
import { HttpError } from '../http-errors.ts';
import type { Data, EvScheduleEntry, EvScheduleEntryType } from '../types.ts';

export interface EvScheduleEntryInput {
  type?: unknown;
  time?: unknown;
  soc_percent?: unknown;
}

const TYPES = new Set<EvScheduleEntryType>(['arrival', 'departure', 'target']);

function toTimestamp(value: string, field: string): number {
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) throw new HttpError(400, `${field} must be a valid timestamp`);
  return ts;
}

/**
 * Parse and validate the user-supplied fields of an EV schedule entry. `soc_percent` is required
 * (in [0,100]) for a target, optional for arrival/departure. Unlike prediction adjustments, past
 * times are allowed — entries persist until pruned, so they can be entered in advance.
 */
function parseEntryFields(
  input: EvScheduleEntryInput,
  base?: EvScheduleEntry,
  _nowMs = Date.now(),
): Omit<EvScheduleEntry, 'id' | 'createdAt' | 'updatedAt'> {
  const type = (input.type ?? base?.type) as EvScheduleEntryType;
  if (!TYPES.has(type)) throw new HttpError(400, 'type must be "arrival", "departure" or "target"');

  const time = String(input.time ?? base?.time ?? '');
  const timeMs = toTimestamp(time, 'time');

  // Distinguish "field absent" (keep the existing value) from "field present but empty"
  // (the user cleared it), so an edit can actually remove a previously-set soc_percent.
  const socRaw = input.soc_percent !== undefined ? input.soc_percent : base?.soc_percent;
  const hasSoc = socRaw != null && socRaw !== '';
  let soc_percent: number | undefined;
  if (hasSoc) {
    soc_percent = Number(socRaw);
    if (!Number.isFinite(soc_percent) || soc_percent < 0 || soc_percent > 100) {
      throw new HttpError(400, 'soc_percent must be a number in [0, 100]');
    }
  } else if (type === 'target') {
    throw new HttpError(400, 'target entries require soc_percent in [0, 100]');
  }

  return {
    type,
    time: new Date(timeMs).toISOString(),
    ...(soc_percent != null ? { soc_percent } : {}),
  };
}

export function validateEvScheduleEntry(entry: EvScheduleEntry): void {
  parseEntryFields(entry, undefined, 0);
  if (!entry.id || typeof entry.id !== 'string') {
    throw new Error('Invalid evScheduleEntries: id must be a string');
  }
  if (Number.isNaN(new Date(entry.createdAt).getTime())) {
    throw new Error('Invalid evScheduleEntries: createdAt must be a valid timestamp');
  }
  if (Number.isNaN(new Date(entry.updatedAt).getTime())) {
    throw new Error('Invalid evScheduleEntries: updatedAt must be a valid timestamp');
  }
}

export function createEvScheduleEntry(input: EvScheduleEntryInput, nowMs = Date.now()): EvScheduleEntry {
  const nowIso = new Date(nowMs).toISOString();
  return {
    id: randomUUID(),
    ...parseEntryFields(input, undefined, nowMs),
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

export function updateEvScheduleEntry(
  existing: EvScheduleEntry,
  input: EvScheduleEntryInput,
  nowMs = Date.now(),
): EvScheduleEntry {
  // Take id/createdAt from the existing entry, but let parseEntryFields produce the full content
  // (type/time/soc_percent). Spreading `existing` wholesale would resurrect a cleared soc_percent.
  return {
    id: existing.id,
    ...parseEntryFields(input, existing, nowMs),
    createdAt: existing.createdAt,
    updatedAt: new Date(nowMs).toISOString(),
  };
}

export function pruneExpiredEvScheduleEntries(
  data: Data,
  nowMs = Date.now(),
): { data: Data; changed: boolean; entries: EvScheduleEntry[] } {
  const entries = data.evScheduleEntries ?? [];
  const active = entries.filter(entry => toTimestamp(entry.time, 'time') >= nowMs);
  if (active.length === entries.length) return { data, changed: false, entries: active };
  return { data: { ...data, evScheduleEntries: active }, changed: true, entries: active };
}
