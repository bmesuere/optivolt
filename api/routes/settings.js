import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertCondition, toHttpError } from '../http-errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const DEFAULT_PATH = path.resolve(__dirname, '../../lib/default-settings.json');

const router = express.Router();

async function readJson(filePath) {
  const data = await fs.readFile(filePath, 'utf8');
  return JSON.parse(data);
}

router.get('/', async (req, res, next) => {
  try {
    try {
      const settings = await readJson(SETTINGS_PATH);
      res.json(settings);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }

    const defaults = await readJson(DEFAULT_PATH);
    res.json(defaults);
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read settings'));
  }
});

router.post('/', async (req, res, next) => {
  try {
    const settings = req.body ?? {};
    assertCondition(settings && typeof settings === 'object' && !Array.isArray(settings), 400, 'settings payload must be an object');

    const data = `${JSON.stringify(settings, null, 2)}\n`;
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(SETTINGS_PATH, data, 'utf8');
    res.json({ message: 'Settings saved successfully.' });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to save settings'));
  }
});

export default router;
