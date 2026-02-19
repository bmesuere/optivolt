import express from 'express';
import { loadData, saveData } from '../services/data-store.js';
import { HttpError, toHttpError } from '../http-errors.js';

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
    const payload = req.body;

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new HttpError(400, 'Payload must be a JSON object');
    }

    const currentData = await loadData();

    // keys allowed to be updated
    const allowedKeys = ['load', 'pv', 'importPrice', 'exportPrice', 'soc'];
    const keysToUpdate = Object.keys(payload).filter(k => allowedKeys.includes(k));

    if (keysToUpdate.length === 0) {
      throw new HttpError(400, 'No valid data keys provided', { details: { keysUpdated: [] } });
    }

    const nextData = { ...currentData };

    try {
      for (const key of keysToUpdate) {
        const series = payload[key];
        if (key === 'soc') {
          validateSoC(series);
        } else {
          validateSeries(series, key);
        }
        nextData[key] = series;
      }
    } catch (validationError) {
      return next(toHttpError(validationError, 400, validationError.message));
    }

    try {
      await saveData(nextData);
      logDataUpdateCall(keysToUpdate);
      res.json({ message: 'Data updated successfully', keysUpdated: keysToUpdate });
    } catch (saveError) {
      next(toHttpError(saveError, 500, 'Failed to persist data'));
    }

  } catch (error) {
    // Catch-all for unexpected synchronous errors in the route setup (unlikely),
    // or if toHttpError throws.
    next(toHttpError(error, 500));
  }
});


function logDataUpdateCall(keysUpdated) {
  const timestamp = new Date().toISOString();
  console.log('[data] update', {
    timestamp,
    keysUpdated,
  });
}

function validateSeries(obj, name) {
  if (!obj || typeof obj !== 'object') throw new Error(`Invalid ${name} object`);

  if (!obj.start) throw new Error(`${name} missing 'start' ISO timestamp`);
  if (isNaN(Date.parse(obj.start))) throw new Error(`${name} 'start' must be a valid ISO string`);

  // We strictly expect 'values' array now
  if (!Array.isArray(obj.values)) throw new Error(`${name} must contain 'values' array`);

  if (obj.step !== undefined) {
    if (!Number.isFinite(obj.step) || obj.step <= 0) {
      throw new Error(`${name} 'step' must be a positive number`);
    }
  }
}

function validateSoC(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Invalid soc object');
  if (!Number.isFinite(obj.value)) throw new Error('soc must contain numeric "value"');
  if (!obj.timestamp || isNaN(Date.parse(obj.timestamp))) throw new Error('soc must contain valid "timestamp" ISO string');
}

export default router;
