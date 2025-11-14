import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Allow overriding via env (e.g. Home Assistant mounts persistent state at /data)
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.resolve(__dirname, '../../data'));
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const DEFAULT_PATH = path.resolve(__dirname, '../../lib/default-settings.json');

async function readJson(filePath) {
  const txt = await fs.readFile(filePath, 'utf8');
  return JSON.parse(txt);
}

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
  const data = `${JSON.stringify(settings, null, 2)}\n`;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_PATH, data, 'utf8');
}

/**
 * Optional: read only the defaults (no fallback).
 */
export async function loadDefaultSettings() {
  return readJson(DEFAULT_PATH);
}
