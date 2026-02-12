import path from 'node:path';
import { resolveDataDir, readJson, writeJson } from './json-store.js';

const DATA_DIR = resolveDataDir();
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const DEFAULT_PATH = new URL('../defaults/default-settings.json', import.meta.url).pathname;

/**
 * Load stored settings or fall back to defaults.
 * This is the canonical way to read settings everywhere.
 */
export async function loadSettings() {
  const defaults = await readJson(DEFAULT_PATH);
  try {
    const settings = await readJson(SETTINGS_PATH);
    // Deep merge dataSources to ensure new keys (soc: mqtt) are picked up
    const mergedDataSources = { ...(defaults.dataSources || {}), ...(settings.dataSources || {}) };
    return { ...defaults, ...settings, dataSources: mergedDataSources };
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    return defaults;
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
