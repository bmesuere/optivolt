import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir, readJson, writeJson } from './json-store.ts';
import { bumpSolverInputsVersion } from './solver-inputs-version.ts';
import type { Settings } from '../types.ts';

const DATA_DIR = resolveDataDir();
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const DEFAULT_PATH = fileURLToPath(new URL('../defaults/default-settings.json', import.meta.url));

const NUMERIC_FIELDS: (keyof Settings)[] = [
  'stepSize_m', 'batteryCapacity_Wh', 'minSoc_percent', 'maxSoc_percent',
  'maxChargePower_W', 'maxDischargePower_W',
  'maxGridImport_W', 'maxGridExport_W', 'chargeEfficiency_percent',
  'dischargeEfficiency_percent', 'batteryCost_cent_per_kWh', 'idleDrain_W',
  'terminalSocCustomPrice_cents_per_kWh', 'rebalanceHoldHours',
  'evMinChargeCurrent_A', 'evMaxChargeCurrent_A', 'evBatteryCapacity_kWh',
  'evChargeEfficiency_percent', 'evSocValue_cents_per_kWh', 'evTripSocBuffer_percent',
  'extendedHorizonDays',
];

function validateSettings(s: Settings): Settings {
  for (const field of NUMERIC_FIELDS) {
    if (!Number.isFinite(s[field] as number)) {
      throw new Error(`Invalid numeric setting: ${field}`);
    }
  }

  // Clamp SoC percentages to [0, 100] and ensure min ≤ max.
  s.minSoc_percent = Math.round(100 * Math.max(0, Math.min(1, s.minSoc_percent / 100)));
  s.maxSoc_percent = Math.round(100 * Math.max(0, Math.min(1, s.maxSoc_percent / 100)));
  if (s.maxSoc_percent < s.minSoc_percent) {
    [s.minSoc_percent, s.maxSoc_percent] = [s.maxSoc_percent, s.minSoc_percent];
  }

  // A negative valuation would invert the incentive and penalize EV charging.
  s.evSocValue_cents_per_kWh = Math.max(0, s.evSocValue_cents_per_kWh);

  // Trip buffer is a SoC share on top of the trip usage; clamp to a sane [0, 100].
  s.evTripSocBuffer_percent = Math.max(0, Math.min(100, s.evTripSocBuffer_percent));

  // Whole days only; 6 extra days is the practical limit of the price forecast feed.
  s.extendedHorizonDays = Math.max(0, Math.min(6, Math.round(s.extendedHorizonDays)));

  if (typeof s.priceForecastUrl !== 'string') {
    s.priceForecastUrl = '';
  }

  if (!Array.isArray(s.optimizerQuickSettings)) {
    s.optimizerQuickSettings = [];
  } else {
    s.optimizerQuickSettings = s.optimizerQuickSettings.filter((id): id is string => typeof id === 'string');
  }

  return s;
}

/**
 * Load stored settings or fall back to defaults.
 * This is the canonical way to read settings everywhere.
 */
export async function loadSettings(): Promise<Settings> {
  const defaults = await readJson<Settings>(DEFAULT_PATH);
  try {
    const settings = await readJson<Partial<Settings>>(SETTINGS_PATH);
    const mergedDataSources = { ...defaults.dataSources, ...settings.dataSources };
    return validateSettings({ ...defaults, ...settings, dataSources: mergedDataSources });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return validateSettings(defaults);
  }
}

// Serialized form of the last save; see the matching note in data-store.ts.
let lastSavedJson: string | undefined;

/**
 * Persist settings to DATA_DIR/settings.json (pretty-printed).
 */
export async function saveSettings(settings: Settings): Promise<void> {
  const json = JSON.stringify(settings);
  if (json !== lastSavedJson) {
    lastSavedJson = json;
    bumpSolverInputsVersion();
  }
  await writeJson(SETTINGS_PATH, settings);
}

/**
 * Read only the defaults (no fallback).
 */
export async function loadDefaultSettings(): Promise<Settings> {
  return readJson<Settings>(DEFAULT_PATH);
}
