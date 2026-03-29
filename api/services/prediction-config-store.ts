import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir, readJson, writeJson } from './json-store.ts';
import type { PredictionConfig } from '../types.ts';

const DATA_DIR = resolveDataDir();
const PREDICTION_CONFIG_PATH = path.join(DATA_DIR, 'prediction-config.json');
const DEFAULT_PATH = fileURLToPath(new URL('../defaults/default-prediction-config.json', import.meta.url));

export async function loadPredictionConfig(): Promise<PredictionConfig> {
  const defaults = await readJson<PredictionConfig>(DEFAULT_PATH);
  let userConfig: Record<string, unknown> = {};
  try {
    const parsed = await readJson<unknown>(PREDICTION_CONFIG_PATH);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      userConfig = parsed as Record<string, unknown>;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  // Migrate old activeConfig format to historicalPredictor + activeType
  if ('activeConfig' in userConfig && !('historicalPredictor' in userConfig)) {
    const old = userConfig.activeConfig;
    if (typeof old === 'object' && old !== null && !Array.isArray(old)) {
      const o = old as Record<string, unknown>;
      const { activeConfig: _ac, ...rest } = userConfig;
      userConfig = {
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

  // Strip activeConfig from userConfig (guard for stored configs that have both activeConfig and historicalPredictor)
  const { activeConfig: _ac, ...cleanUserConfig } = userConfig;
  const merged = { ...defaults, ...(cleanUserConfig as Partial<PredictionConfig>) };
  const { validationWindow: _vw, ...rest } = merged;

  // Always recompute validationWindow — never trust a persisted value
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);

  return {
    ...rest,
    validationWindow: { start: start.toISOString(), end: end.toISOString() },
  };
}

export async function savePredictionConfig(config: PredictionConfig): Promise<void> {
  await writeJson(PREDICTION_CONFIG_PATH, config);
}
