import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir, readJson, writeJson } from './json-store.ts';
import type { Data, TimeSeries } from '../types.ts';
import { validatePredictionAdjustment } from './prediction-adjustments.ts';

const DATA_DIR = resolveDataDir();
const DATA_PATH = path.join(DATA_DIR, 'data.json');
const DEFAULT_PATH = fileURLToPath(new URL('../defaults/default-data.json', import.meta.url));

function validateTimeSeries(ts: TimeSeries, label: string): void {
  if (!ts || typeof ts !== 'object') {
    throw new Error(`Invalid ${label}: must be an object`);
  }
  if (Number.isNaN(new Date(ts.start).getTime())) {
    throw new Error(`Invalid ${label}: 'start' is not a valid timestamp (${ts.start})`);
  }
  if (!Array.isArray(ts.values)) {
    throw new Error(`Invalid ${label}: 'values' must be an array`);
  }
  if (ts.step !== undefined && !(Number.isFinite(ts.step) && ts.step > 0)) {
    throw new Error(`Invalid ${label}: 'step' must be a positive number`);
  }
}

export function validateData(d: Data): Data {
  validateTimeSeries(d.load, 'load');
  validateTimeSeries(d.pv, 'pv');
  validateTimeSeries(d.importPrice, 'importPrice');
  validateTimeSeries(d.exportPrice, 'exportPrice');
  if (!Number.isFinite(d.soc.value)) {
    throw new Error('Invalid soc: value must be a finite number; refresh VRM data first');
  }
  if (Number.isNaN(new Date(d.soc.timestamp).getTime())) {
    throw new Error(`Invalid soc: 'timestamp' is not a valid timestamp (${d.soc.timestamp})`);
  }
  if (d.predictionAdjustments !== undefined) {
    if (!Array.isArray(d.predictionAdjustments)) {
      throw new Error("Invalid predictionAdjustments: must be an array");
    }
    for (const adjustment of d.predictionAdjustments) {
      validatePredictionAdjustment(adjustment);
    }
  }
  return d;
}

/**
 * Load stored data or fall back to defaults.
 */
export async function loadData(): Promise<Data> {
  try {
    return validateData(await readJson<Data>(DATA_PATH));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const defaults = await readJson<Data>(DEFAULT_PATH);

    // Shift defaults to "start of current hour" so we have full 24h of future data
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const startTimeStr = now.toISOString();

    defaults.load.start = startTimeStr;
    defaults.pv.start = startTimeStr;
    defaults.importPrice.start = startTimeStr;
    defaults.exportPrice.start = startTimeStr;
    defaults.soc.timestamp = startTimeStr;

    return validateData(defaults);
  }
}

/**
 * Persist data to DATA_DIR/data.json (pretty-printed).
 */
export async function saveData(data: Data): Promise<void> {
  validateData(data);
  await writeJson(DATA_PATH, data);
}

/**
 * Read only the defaults (no fallback).
 */
export async function loadDefaultData(): Promise<Data> {
  return readJson<Data>(DEFAULT_PATH);
}
