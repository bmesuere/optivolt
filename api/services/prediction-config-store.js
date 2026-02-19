import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir, readJson, writeJson } from './json-store.js';

const DATA_DIR = resolveDataDir();
const PREDICTION_CONFIG_PATH = path.join(DATA_DIR, 'prediction-config.json');
const DEFAULT_PATH = fileURLToPath(new URL('../defaults/default-prediction-config.json', import.meta.url));

export async function loadPredictionConfig() {
  const defaults = await readJson(DEFAULT_PATH);
  let userConfig = {};
  try {
    userConfig = await readJson(PREDICTION_CONFIG_PATH);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  const merged = { ...defaults, ...userConfig };

  // Dynamic default: validationWindow = last 7 full days (ending at start of today)
  if (!merged.validationWindow?.start || !merged.validationWindow?.end) {
    const now = new Date();
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); // Start of today (UTC)
    const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000); // 7 days ago

    merged.validationWindow = {
      start: start.toISOString(),
      end: end.toISOString(),
    };
  }

  return merged;
}

export async function savePredictionConfig(config) {
  await writeJson(PREDICTION_CONFIG_PATH, config);
}
