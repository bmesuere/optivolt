import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same DATA_DIR convention as settings-store
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.resolve(__dirname, '../../data'));
const DATA_PATH = path.join(DATA_DIR, 'data.json');
const DEFAULT_PATH = path.resolve(__dirname, '../../lib/default-data.json');

async function readJson(filePath) {
  const txt = await fs.readFile(filePath, 'utf8');
  return JSON.parse(txt);
}

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
  const json = `${JSON.stringify(data, null, 2)}\n`;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(DATA_PATH, json, 'utf8');
}

/**
 * Optional: read only the defaults (no fallback).
 */
export async function loadDefaultData() {
  return readJson(DEFAULT_PATH);
}
