import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir, readJson, writeJson } from './json-store.ts';
import { bumpSolverInputsVersion } from './solver-inputs-version.ts';
import type { Data, TimeSeries } from '../types.ts';
import { validatePredictionAdjustment } from './prediction-adjustments.ts';
import { validateEvScheduleEntry } from './ev-schedule-entries.ts';
import { recordFullSocObservation } from './rebalance-nudge.ts';

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
  if (d.importPriceForecast !== undefined) validateTimeSeries(d.importPriceForecast, 'importPriceForecast');
  if (d.exportPriceForecast !== undefined) validateTimeSeries(d.exportPriceForecast, 'exportPriceForecast');
  if (!Number.isFinite(d.soc.value)) {
    throw new Error('Invalid soc: value must be a finite number; refresh VRM data first');
  }
  if (Number.isNaN(new Date(d.soc.timestamp).getTime())) {
    throw new Error(`Invalid soc: 'timestamp' is not a valid timestamp (${d.soc.timestamp})`);
  }
  if (d.lastFullSocAt !== undefined && d.lastFullSocAt !== null) {
    if (typeof d.lastFullSocAt !== 'string' || Number.isNaN(new Date(d.lastFullSocAt).getTime())) {
      throw new Error(`Invalid lastFullSocAt: must be null or a valid timestamp (${d.lastFullSocAt})`);
    }
  }
  if (d.predictionAdjustments !== undefined) {
    if (!Array.isArray(d.predictionAdjustments)) {
      throw new Error("Invalid predictionAdjustments: must be an array");
    }
    for (const adjustment of d.predictionAdjustments) {
      validatePredictionAdjustment(adjustment);
    }
  }
  if (d.evScheduleEntries !== undefined) {
    if (!Array.isArray(d.evScheduleEntries)) {
      throw new Error("Invalid evScheduleEntries: must be an array");
    }
    for (const entry of d.evScheduleEntries) {
      validateEvScheduleEntry(entry);
    }
  }
  if (d.evLastState !== undefined) {
    const s = d.evLastState;
    if (!s || typeof s !== 'object' || typeof s.pluggedIn !== 'boolean') {
      throw new Error('Invalid evLastState: pluggedIn must be a boolean');
    }
    if (s.soc_percent !== null && !Number.isFinite(s.soc_percent)) {
      throw new Error('Invalid evLastState: soc_percent must be null or a finite number');
    }
    if (Number.isNaN(new Date(s.observedAt).getTime())) {
      throw new Error(`Invalid evLastState: observedAt is not a valid timestamp (${s.observedAt})`);
    }
  }
  return d;
}

export const DATA_SCHEMA_VERSION = 1;

/**
 * Bring persisted data of any prior shape up to the current schema.
 * Version 0 = files written before versioning existed. Missing keys fall back
 * to defaults instead of throwing on boot, so adding a required field to Data
 * can never brick an existing install.
 */
function migrateData(raw: Partial<Data>, defaults: Data): Data {
  const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0;
  if (version > DATA_SCHEMA_VERSION) {
    console.warn(`data.json schemaVersion ${version} is newer than supported ${DATA_SCHEMA_VERSION}; loading best-effort`);
  }
  // v0 → v1: no shape change — versioning introduced.
  // A newer on-disk marker is preserved (not downgraded): relabelling a
  // v(N+1) file as vN would make the next upgrade re-run its migration on
  // already-migrated state.
  return { ...defaults, ...raw, schemaVersion: Math.max(version, DATA_SCHEMA_VERSION) };
}

/**
 * Load stored data (migrated to the current schema) or fall back to defaults.
 */
export async function loadData(): Promise<Data> {
  const defaults = await readJson<Data>(DEFAULT_PATH);
  try {
    return validateData(migrateData(await readJson<Partial<Data>>(DATA_PATH), defaults));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;

    // Shift defaults to "start of current hour" so we have full 24h of future data
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const startTimeStr = now.toISOString();

    defaults.load.start = startTimeStr;
    defaults.pv.start = startTimeStr;
    defaults.importPrice.start = startTimeStr;
    defaults.exportPrice.start = startTimeStr;
    defaults.soc.timestamp = startTimeStr;

    return validateData({ ...defaults, schemaVersion: DATA_SCHEMA_VERSION });
  }
}

// Serialized form of the last save, to bump the solver-inputs version only on
// real changes — the boot-time forecast run often rewrites identical series,
// and that must not read as "the cached plan is stale".
let lastSavedJson: string | undefined;

/**
 * Persist data to DATA_DIR/data.json (pretty-printed).
 *
 * Every save records a full-SoC observation (for the rebalance nudge) so no
 * write path can forget it; persisted data therefore always carries an
 * up-to-date lastFullSocAt even when the caller's in-memory copy does not.
 */
export async function saveData(data: Data): Promise<void> {
  const next = recordFullSocObservation(validateData({ ...data, schemaVersion: Math.max(data.schemaVersion ?? 0, DATA_SCHEMA_VERSION) }));
  const json = JSON.stringify(next);
  if (json !== lastSavedJson) {
    lastSavedJson = json;
    bumpSolverInputsVersion();
  }
  await writeJson(DATA_PATH, next);
}

/**
 * Read only the defaults (no fallback).
 */
export async function loadDefaultData(): Promise<Data> {
  return readJson<Data>(DEFAULT_PATH);
}
