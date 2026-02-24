import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir, readJson, writeJson } from './json-store.ts';
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

/**
 * Persist settings to DATA_DIR/settings.json (pretty-printed).
 */
export async function saveSettings(settings: Settings): Promise<void> {
  await writeJson(SETTINGS_PATH, settings);
}

/**
 * Read only the defaults (no fallback).
 */
export async function loadDefaultSettings(): Promise<Settings> {
  return readJson<Settings>(DEFAULT_PATH);
}
