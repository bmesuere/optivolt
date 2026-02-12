import path from 'node:path';
import { resolveDataDir, readJson, writeJson } from './json-store.js';

const DATA_DIR = resolveDataDir();
const DATA_PATH = path.join(DATA_DIR, 'data.json');
const DEFAULT_PATH = new URL('../defaults/default-data.json', import.meta.url).pathname;

/**
 * Load stored data or fall back to defaults.
 */
export async function loadData() {
  try {
    return await readJson(DATA_PATH);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    const defaults = await readJson(DEFAULT_PATH);

    // Dynamically shift defaults to "start of current hour" so we have full 24h of future data
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const startTimeStr = now.toISOString();

    if (defaults.load) defaults.load.start = startTimeStr;
    if (defaults.pv) defaults.pv.start = startTimeStr;
    if (defaults.importPrice) defaults.importPrice.start = startTimeStr;
    if (defaults.exportPrice) defaults.exportPrice.start = startTimeStr;
    if (defaults.soc) defaults.soc.timestamp = startTimeStr;

    return defaults;
  }
}

/**
 * Persist data to DATA_DIR/data.json (pretty-printed).
 */
export async function saveData(data) {
  await writeJson(DATA_PATH, data);
}

/**
 * Read only the defaults (no fallback).
 */
export async function loadDefaultData() {
  return readJson(DEFAULT_PATH);
}
