import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir, readJson, writeJson } from './json-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Allow overriding via env (e.g. Home Assistant mounts persistent state at /data)
const DATA_DIR = resolveDataDir();
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const DEFAULT_PATH = path.resolve(__dirname, '../defaults/default-settings.json');

/**
 * Load stored settings or fall back to defaults.
 * This is the canonical way to read settings everywhere.
 */
export async function loadSettings() {
  try {
    return await readJson(SETTINGS_PATH);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    return readJson(DEFAULT_PATH);
  }
}

/**
 * Persist settings to DATA_DIR/settings.json (pretty-printed).
 */
export async function saveSettings(settings) {
  await writeJson(SETTINGS_PATH, settings);
}

/**
 * Read only the defaults (no fallback).
 */
export async function loadDefaultSettings() {
  return readJson(DEFAULT_PATH);
}
