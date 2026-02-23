import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { loadData, saveData } from '../services/data-store.ts';
import { loadSettings } from '../services/settings-store.ts';
import { HttpError, toHttpError } from '../http-errors.ts';

const router = express.Router();

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await loadData();
    res.json(data);
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to load data'));
  }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const payload = req.body as Record<string, unknown>;

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new HttpError(400, 'Payload must be a JSON object');
    }

    const currentData = await loadData();
    const settings = await loadSettings();
    const dataSources = settings.dataSources;

    const sourceMapping: Record<string, string> = {
      load: dataSources.load,
      pv: dataSources.pv,
      importPrice: dataSources.prices,
      exportPrice: dataSources.prices,
      soc: dataSources.soc,
    };

    const allowedKeys = ['load', 'pv', 'importPrice', 'exportPrice', 'soc'];
    const keysToUpdate = Object.keys(payload).filter(k => allowedKeys.includes(k) && sourceMapping[k] === 'api');

    if (keysToUpdate.length === 0) {
      throw new HttpError(400, 'No valid data keys provided or settings are not set to API', { details: { keysUpdated: [] } });
    }

    const nextData = { ...currentData } as Record<string, unknown>;

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
      const msg = validationError instanceof Error ? validationError.message : String(validationError);
      return next(toHttpError(validationError, 400, msg));
    }

    try {
      await saveData(nextData as unknown as typeof currentData);
      logDataUpdateCall(keysToUpdate);
      res.json({ message: 'Data updated successfully', keysUpdated: keysToUpdate });
    } catch (saveError) {
      next(toHttpError(saveError, 500, 'Failed to persist data'));
    }

  } catch (error) {
    next(toHttpError(error, 500));
  }
});

function logDataUpdateCall(keysUpdated: string[]): void {
  console.log('[data] update', {
    timestamp: new Date().toISOString(),
    keysUpdated,
  });
}

function validateSeries(obj: unknown, name: string): void {
  if (!obj || typeof obj !== 'object') throw new Error(`Invalid ${name} object`);
  const o = obj as Record<string, unknown>;

  if (!o.start) throw new Error(`${name} missing 'start' ISO timestamp`);
  if (isNaN(Date.parse(o.start as string))) throw new Error(`${name} 'start' must be a valid ISO string`);

  if (!Array.isArray(o.values)) throw new Error(`${name} must contain 'values' array`);

  if (o.step !== undefined) {
    if (!Number.isFinite(o.step) || (o.step as number) <= 0) {
      throw new Error(`${name} 'step' must be a positive number`);
    }
  }
}

function validateSoC(obj: unknown): void {
  if (!obj || typeof obj !== 'object') throw new Error('Invalid soc object');
  const o = obj as Record<string, unknown>;
  if (!Number.isFinite(o.value)) throw new Error('soc must contain numeric "value"');
  if (!o.timestamp || isNaN(Date.parse(o.timestamp as string))) throw new Error('soc must contain valid "timestamp" ISO string');
}

export default router;
