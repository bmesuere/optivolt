import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir, readJson, writeJson } from './json-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same DATA_DIR convention as settings-store
const DATA_DIR = resolveDataDir();
const DATA_PATH = path.join(DATA_DIR, 'data.json');
const DEFAULT_PATH = path.resolve(__dirname, '../defaults/default-data.json');

/**
 * Load stored data or fall back to defaults.
 */
export async function loadData() {
  try {
    return await readJson(DATA_PATH);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    return readJson(DEFAULT_PATH);
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
