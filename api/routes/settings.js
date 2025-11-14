import express from 'express';
import { assertCondition, toHttpError } from '../http-errors.js';
import { loadSettings, saveSettings } from '../services/settings-store.js';

const router = express.Router();

// Keys that belong to the "data" layer and should *not* be overwritten by the UI.
const DATA_KEYS = new Set([
  'load_W',
  'pv_W',
  'importPrice',
  'exportPrice',
  'initialSoc_percent',
  'tsStart',
]);

router.get('/', async (_req, res, next) => {
  try {
    const settings = await loadSettings();
    res.json(settings || {});
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read settings'));
  }
});

router.post('/', async (req, res, next) => {
  try {
    const incoming = req.body ?? {};
    assertCondition(
      incoming && typeof incoming === 'object' && !Array.isArray(incoming),
      400,
      'settings payload must be an object',
    );

    const prev = await loadSettings();

    // Drop any attempted writes to data fields
    const cleaned = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (DATA_KEYS.has(key)) continue;
      cleaned[key] = value;
    }

    const merged = { ...prev, ...cleaned };
    await saveSettings(merged);

    res.json({ message: 'Settings saved successfully.', settings: merged });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to save settings'));
  }
});

export default router;
