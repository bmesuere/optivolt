import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir, readJson, writeJson } from './json-store.ts';
import { bumpSolverInputsVersion } from './solver-inputs-version.ts';
import type { Settings, DataSources } from '../types.ts';
import type { TerminalSocValuation } from '../../lib/types.ts';

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

// Strictly positive: zero step size, capacities, hold hours, or charge currents are unusable.
const POSITIVE_FIELDS: (keyof Settings)[] = [
  'stepSize_m', 'batteryCapacity_Wh', 'rebalanceHoldHours',
  'evMinChargeCurrent_A', 'evMaxChargeCurrent_A', 'evBatteryCapacity_kWh',
];

// Zero is a valid limit/cost (e.g. no grid export allowed); negative is not.
const NON_NEGATIVE_FIELDS: (keyof Settings)[] = [
  'maxChargePower_W', 'maxDischargePower_W', 'maxGridImport_W', 'maxGridExport_W',
  'batteryCost_cent_per_kWh', 'idleDrain_W',
];

// Efficiencies divide LP cost coefficients: zero would produce infinite costs.
const EFFICIENCY_FIELDS: (keyof Settings)[] = [
  'chargeEfficiency_percent', 'dischargeEfficiency_percent', 'evChargeEfficiency_percent',
];

const BOOLEAN_FIELDS: (keyof Settings)[] = [
  'blockFeedInOnNegativePrices', 'rebalanceEnabled', 'evEnabled',
];

const STRING_FIELDS: (keyof Settings)[] = ['haUrl', 'haToken', 'evSocSensor', 'evPlugSensor'];

const TERMINAL_SOC_VALUATIONS: readonly TerminalSocValuation[] = ['zero', 'min', 'avg', 'max', 'custom'];

const DATA_SOURCE_DOMAINS: Record<keyof DataSources, readonly string[]> = {
  load: ['vrm', 'api'],
  pv: ['vrm', 'api'],
  prices: ['vrm', 'api'],
  soc: ['mqtt', 'api'],
};

/** Thrown when settings fail validation; lets callers map it to a 400 instead of a generic 500. */
export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsValidationError';
  }
}

function validateSettings(s: Settings): Settings {
  for (const field of NUMERIC_FIELDS) {
    if (!Number.isFinite(s[field] as number)) {
      throw new SettingsValidationError(`Invalid numeric setting: ${field}`);
    }
  }
  for (const field of POSITIVE_FIELDS) {
    if ((s[field] as number) <= 0) {
      throw new SettingsValidationError(`Invalid setting: ${field} must be > 0`);
    }
  }
  for (const field of NON_NEGATIVE_FIELDS) {
    if ((s[field] as number) < 0) {
      throw new SettingsValidationError(`Invalid setting: ${field} must be >= 0`);
    }
  }
  for (const field of EFFICIENCY_FIELDS) {
    const value = s[field] as number;
    if (value <= 0 || value > 100) {
      throw new SettingsValidationError(`Invalid setting: ${field} must be in (0, 100]`);
    }
  }
  for (const field of BOOLEAN_FIELDS) {
    if (typeof s[field] !== 'boolean') {
      throw new SettingsValidationError(`Invalid setting: ${field} must be a boolean`);
    }
  }
  for (const field of STRING_FIELDS) {
    if (typeof s[field] !== 'string') {
      throw new SettingsValidationError(`Invalid setting: ${field} must be a string`);
    }
  }

  if (!TERMINAL_SOC_VALUATIONS.includes(s.terminalSocValuation)) {
    throw new SettingsValidationError(
      `Invalid setting: terminalSocValuation must be one of ${TERMINAL_SOC_VALUATIONS.join(', ')}`,
    );
  }

  const sources = s.dataSources as unknown;
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) {
    throw new SettingsValidationError('Invalid setting: dataSources must be an object');
  }
  for (const [key, domain] of Object.entries(DATA_SOURCE_DOMAINS)) {
    const value = (sources as Record<string, unknown>)[key];
    if (typeof value !== 'string' || !domain.includes(value)) {
      throw new SettingsValidationError(
        `Invalid setting: dataSources.${key} must be one of ${domain.join(', ')}`,
      );
    }
  }

  // Clamp SoC percentages to [0, 100] and ensure min ≤ max.
  s.minSoc_percent = Math.round(100 * Math.max(0, Math.min(1, s.minSoc_percent / 100)));
  s.maxSoc_percent = Math.round(100 * Math.max(0, Math.min(1, s.maxSoc_percent / 100)));
  if (s.maxSoc_percent < s.minSoc_percent) {
    [s.minSoc_percent, s.maxSoc_percent] = [s.maxSoc_percent, s.minSoc_percent];
  }

  // Keep the EV charge-current window ordered; min above max is infeasible.
  if (s.evMaxChargeCurrent_A < s.evMinChargeCurrent_A) {
    [s.evMinChargeCurrent_A, s.evMaxChargeCurrent_A] = [s.evMaxChargeCurrent_A, s.evMinChargeCurrent_A];
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

export const SETTINGS_SCHEMA_VERSION = 1;

/**
 * Bring persisted settings of any prior shape up to the current schema.
 * Version 0 = files written before versioning existed. Missing keys are
 * covered by the defaults merge in loadSettings, so v0 → v1 has no steps.
 * A newer on-disk marker is preserved through load/save (never downgraded),
 * so an upgrade after a downgrade cannot re-run migrations on migrated state.
 */
function migrateSettings(raw: Partial<Settings>): Partial<Settings> {
  const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0;
  if (version > SETTINGS_SCHEMA_VERSION) {
    console.warn(`settings.json schemaVersion ${version} is newer than supported ${SETTINGS_SCHEMA_VERSION}; loading best-effort`);
  }
  return raw;
}

/**
 * Load stored settings (migrated to the current schema) or fall back to defaults.
 * This is the canonical way to read settings everywhere.
 */
export async function loadSettings(): Promise<Settings> {
  const defaults = await readJson<Settings>(DEFAULT_PATH);
  try {
    const settings = migrateSettings(await readJson<Partial<Settings>>(SETTINGS_PATH));
    const mergedDataSources = { ...defaults.dataSources, ...settings.dataSources };
    // Math.max: never downgrade a newer on-disk marker (see migrateSettings).
    return validateSettings({ ...defaults, ...settings, dataSources: mergedDataSources, schemaVersion: Math.max(settings.schemaVersion ?? 0, SETTINGS_SCHEMA_VERSION) });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return validateSettings({ ...defaults, schemaVersion: SETTINGS_SCHEMA_VERSION });
  }
}

// Serialized form of the last save; see the matching note in data-store.ts.
let lastSavedJson: string | undefined;

/**
 * Persist settings to DATA_DIR/settings.json (pretty-printed).
 * Validates and clamps before writing, so a bad payload can never poison the stored file.
 */
export async function saveSettings(settings: Settings): Promise<void> {
  const validated = validateSettings({ ...settings, schemaVersion: Math.max(settings.schemaVersion ?? 0, SETTINGS_SCHEMA_VERSION) });
  const json = JSON.stringify(validated);
  if (json !== lastSavedJson) {
    lastSavedJson = json;
    bumpSolverInputsVersion();
  }
  await writeJson(SETTINGS_PATH, validated);
}

/**
 * Read only the defaults (no fallback).
 */
export async function loadDefaultSettings(): Promise<Settings> {
  return readJson<Settings>(DEFAULT_PATH);
}
