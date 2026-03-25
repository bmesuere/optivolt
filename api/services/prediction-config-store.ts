import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir, readJson, writeJson } from './json-store.ts';
import type { PredictionConfig } from '../types.ts';

const DATA_DIR = resolveDataDir();
const PREDICTION_CONFIG_PATH = path.join(DATA_DIR, 'prediction-config.json');
const DEFAULT_PATH = fileURLToPath(new URL('../defaults/default-prediction-config.json', import.meta.url));

export async function loadPredictionConfig(): Promise<PredictionConfig> {
  const defaults = await readJson<PredictionConfig>(DEFAULT_PATH);
  let userConfig: Partial<PredictionConfig> = {};
  try {
    userConfig = await readJson<PredictionConfig>(PREDICTION_CONFIG_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const { validationWindow: _vw, ...rest } = { ...defaults, ...userConfig };

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
