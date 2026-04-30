import { randomUUID } from 'node:crypto';
import { HttpError } from '../http-errors.ts';
import type {
  Data,
  PredictionAdjustment,
  PredictionAdjustmentMode,
  PredictionAdjustmentSeries,
  TimeSeries,
} from '../types.ts';

export interface PredictionAdjustmentInput {
  series?: unknown;
  mode?: unknown;
  value_W?: unknown;
  start?: unknown;
  end?: unknown;
  label?: unknown;
}

const SERIES = new Set<PredictionAdjustmentSeries>(['load', 'pv']);
const MODES = new Set<PredictionAdjustmentMode>(['set', 'add']);

function toTimestamp(value: string, field: string): number {
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) throw new HttpError(400, `${field} must be a valid timestamp`);
  return ts;
}

function normalizeLabel(value: unknown): string | undefined {
  if (value == null) return undefined;
  const label = String(value).trim();
  return label ? label.slice(0, 120) : undefined;
}

function parseAdjustmentFields(
  input: PredictionAdjustmentInput,
  base?: PredictionAdjustment,
  nowMs = Date.now(),
): Omit<PredictionAdjustment, 'id' | 'createdAt' | 'updatedAt'> {
  const series = (input.series ?? base?.series) as PredictionAdjustmentSeries;
  if (!SERIES.has(series)) throw new HttpError(400, 'series must be "load" or "pv"');

  const mode = (input.mode ?? base?.mode) as PredictionAdjustmentMode;
  if (!MODES.has(mode)) throw new HttpError(400, 'mode must be "set" or "add"');

  const valueRaw = input.value_W ?? base?.value_W;
  const value_W = Number(valueRaw);
  if (!Number.isFinite(value_W)) throw new HttpError(400, 'value_W must be a finite number');
  if (mode === 'set' && value_W < 0) throw new HttpError(400, 'set adjustments require value_W >= 0');

  const start = String(input.start ?? base?.start ?? '');
  const end = String(input.end ?? base?.end ?? '');
  const startMs = toTimestamp(start, 'start');
  const endMs = toTimestamp(end, 'end');
  if (endMs <= startMs) throw new HttpError(400, 'end must be after start');
  if (endMs <= nowMs) throw new HttpError(400, 'end must be in the future');

  const label = normalizeLabel(input.label ?? base?.label);
  return {
    series,
    mode,
    value_W,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    ...(label ? { label } : {}),
  };
}

export function validatePredictionAdjustment(adjustment: PredictionAdjustment): void {
  parseAdjustmentFields(adjustment, undefined, 0);
  if (!adjustment.id || typeof adjustment.id !== 'string') {
    throw new Error('Invalid predictionAdjustments: id must be a string');
  }
  if (Number.isNaN(new Date(adjustment.createdAt).getTime())) {
    throw new Error('Invalid predictionAdjustments: createdAt must be a valid timestamp');
  }
  if (Number.isNaN(new Date(adjustment.updatedAt).getTime())) {
    throw new Error('Invalid predictionAdjustments: updatedAt must be a valid timestamp');
  }
}

export function createPredictionAdjustment(input: PredictionAdjustmentInput, nowMs = Date.now()): PredictionAdjustment {
  const nowIso = new Date(nowMs).toISOString();
  return {
    id: randomUUID(),
    ...parseAdjustmentFields(input, undefined, nowMs),
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

export function updatePredictionAdjustment(
  existing: PredictionAdjustment,
  input: PredictionAdjustmentInput,
  nowMs = Date.now(),
): PredictionAdjustment {
  return {
    ...existing,
    ...parseAdjustmentFields(input, existing, nowMs),
    updatedAt: new Date(nowMs).toISOString(),
  };
}

export function pruneExpiredPredictionAdjustments(
  data: Data,
  nowMs = Date.now(),
): { data: Data; changed: boolean; adjustments: PredictionAdjustment[] } {
  const adjustments = data.predictionAdjustments ?? [];
  const active = adjustments.filter(adj => toTimestamp(adj.end, 'end') > nowMs);
  if (active.length === adjustments.length) return { data, changed: false, adjustments: active };
  const nextData: Data = { ...data, predictionAdjustments: active };
  return { data: nextData, changed: true, adjustments: active };
}

export function applyPredictionAdjustmentsToSeries(
  series: TimeSeries,
  adjustments: PredictionAdjustment[] | undefined,
  targetSeries: PredictionAdjustmentSeries,
): TimeSeries {
  const relevant = (adjustments ?? []).filter(adj => adj.series === targetSeries);
  if (!relevant.length) return series;

  const startMs = new Date(series.start).getTime();
  const stepMs = (series.step ?? 15) * 60_000;
  const relevantMs = relevant.map(adj => ({ adj, startMs: new Date(adj.start).getTime(), endMs: new Date(adj.end).getTime() }));
  const values = series.values.map((raw, index) => {
    const slotMs = startMs + index * stepMs;
    const matching = relevantMs
      .filter(({ startMs: s, endMs: e }) => slotMs >= s && slotMs < e)
      .map(({ adj }) => adj);
    if (!matching.length) return raw;

    const setAdjustment = matching
      .filter(adj => adj.mode === 'set')
      .reduce<PredictionAdjustment | undefined>((best, adj) => !best || adj.updatedAt > best.updatedAt ? adj : best, undefined);
    const base = setAdjustment ? setAdjustment.value_W : raw;
    const delta = matching
      .filter(adj => adj.mode === 'add')
      .reduce((sum, adj) => sum + adj.value_W, 0);
    return Math.max(0, base + delta);
  });

  return { ...series, values };
}

export function applyPredictionAdjustmentsToData(data: Data): Data {
  const adjustments = data.predictionAdjustments ?? [];
  if (!adjustments.length) return data;
  return {
    ...data,
    load: applyPredictionAdjustmentsToSeries(data.load, adjustments, 'load'),
    pv: applyPredictionAdjustmentsToSeries(data.pv, adjustments, 'pv'),
  };
}
