import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir, readJson, writeJson } from './json-store.ts';
import type { PredictionConfig, PvPredictionConfig } from '../types.ts';

const DATA_DIR = resolveDataDir();
const PREDICTION_CONFIG_PATH = path.join(DATA_DIR, 'prediction-config.json');
const DEFAULT_PATH = fileURLToPath(new URL('../defaults/default-prediction-config.json', import.meta.url));

export const PREDICTION_CONFIG_SCHEMA_VERSION = 1;

/**
 * Bring a persisted config of any prior shape up to the current schema.
 * Version 0 = files written before versioning existed, including the pre-2026
 * `activeConfig` shape (replaced by historicalPredictor + activeType).
 */
function migratePredictionConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0;
  if (version > PREDICTION_CONFIG_SCHEMA_VERSION) {
    console.warn(`prediction-config.json schemaVersion ${version} is newer than supported ${PREDICTION_CONFIG_SCHEMA_VERSION}; loading best-effort`);
  }

  // v0 → v1: fold the old activeConfig shape into historicalPredictor + activeType
  if ('activeConfig' in raw && !('historicalPredictor' in raw)) {
    const old = raw.activeConfig;
    if (typeof old === 'object' && old !== null && !Array.isArray(old)) {
      const o = old as Record<string, unknown>;
      const { activeConfig: _ac, ...rest } = raw;
      raw = {
        ...rest,
        activeType: 'historical',
        historicalPredictor: {
          sensor: o['sensor'],
          lookbackWeeks: o['lookbackWeeks'],
          dayFilter: o['dayFilter'],
          aggregation: o['aggregation'],
        },
      };
    }
  }

  return raw;
}

export async function loadPredictionConfig(): Promise<PredictionConfig> {
  const defaults = await readJson<PredictionConfig>(DEFAULT_PATH);
  let userConfig: Record<string, unknown> = {};
  try {
    const parsed = await readJson<unknown>(PREDICTION_CONFIG_PATH);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      userConfig = migratePredictionConfig(parsed as Record<string, unknown>);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  // Strip activeConfig from userConfig (guard for stored configs that have both activeConfig and historicalPredictor)
  const { activeConfig: _ac, ...cleanUserConfig } = userConfig;
  const cleanConfig = cleanUserConfig as Partial<PredictionConfig>;
  const pvConfig: PredictionConfig['pvConfig'] = (defaults.pvConfig || cleanConfig.pvConfig)
    ? { ...defaults.pvConfig, ...cleanConfig.pvConfig } as PvPredictionConfig
    : undefined;
  const merged = {
    ...defaults,
    ...cleanConfig,
    ...(pvConfig ? { pvConfig } : {}),
  };
  const { validationWindow: _vw, ...rest } = merged;

  // Always recompute validationWindow — never trust a persisted value
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);

  return {
    ...rest,
    schemaVersion: PREDICTION_CONFIG_SCHEMA_VERSION,
    validationWindow: { start: start.toISOString(), end: end.toISOString() },
  };
}

export async function savePredictionConfig(config: PredictionConfig): Promise<void> {
  await writeJson(PREDICTION_CONFIG_PATH, { ...config, schemaVersion: PREDICTION_CONFIG_SCHEMA_VERSION });
}
