import express from 'express';
import { loadData, saveData } from '../services/data-store.js';
import { toHttpError } from '../http-errors.js';

const router = express.Router();

// GET /data - Returns the full current data state
router.get('/', async (req, res, next) => {
  try {
    const data = await loadData();
    res.json(data);
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to load data'));
  }
});

/**
 * POST /data - Update specific data series
 * Payload example:
 * {
 *   "importPrice": { "start": "...", "step": 15, "values": [...] },
 *   "exportPrice": { "start": "...", "step": 15, "values": [...] }
 * }
 */
router.post('/', async (req, res, next) => {
  try {
    const payload = req.body ?? {};
    const currentData = await loadData();

    // keys allowed to be updated
    const allowedKeys = ['load', 'pv', 'importPrice', 'exportPrice', 'soc'];
    const keysToUpdate = Object.keys(payload).filter(k => allowedKeys.includes(k));

    if (keysToUpdate.length === 0) {
      return res.json({ message: 'No valid data keys provided', keysUpdated: [] });
    }

    const nextData = { ...currentData };

    for (const key of keysToUpdate) {
      const series = payload[key];
      // Basic validation
      if (key !== 'soc') {
        validateSeries(series, key);
      }
      nextData[key] = series;
    }

    await saveData(nextData);

    res.json({ message: 'Data updated successfully', keysUpdated: keysToUpdate });
  } catch (error) {
    next(toHttpError(error, 400, error.message || 'Failed to save data'));
  }
});

function validateSeries(obj, name) {
  if (!obj || typeof obj !== 'object') throw new Error(`Invalid ${name} object`);
  if (!obj.start) throw new Error(`${name} missing 'start' ISO timestamp`);
  // We strictly expect 'values' array now
  if (!Array.isArray(obj.values)) throw new Error(`${name} must contain 'values' array`);
  // Optional: validate step?
}

export default router;
