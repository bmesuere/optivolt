import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { loadData, saveData, validateData } from '../services/data-store.ts';
import { loadSettings } from '../services/settings-store.ts';
import { recordFullSocObservation } from '../services/rebalance-nudge.ts';
import { assertCondition, toHttpError } from '../http-errors.ts';
import type { TimeSeries, SocData, Data } from '../types.ts';

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
    assertCondition(
      !!payload && typeof payload === 'object' && !Array.isArray(payload),
      400,
      'Payload must be a JSON object',
    );

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

    assertCondition(
      keysToUpdate.length > 0,
      400,
      'No valid data keys provided or settings are not set to API',
    );

    let nextData: Data = { ...currentData };

    for (const key of keysToUpdate) {
      const value = payload[key];
      assertCondition(
        !!value && typeof value === 'object' && !Array.isArray(value),
        400,
        `'${key}' must be a JSON object`,
      );
      if (key === 'soc') {
        nextData.soc = value as SocData;
        nextData = recordFullSocObservation(nextData);
      } else if (key === 'load' || key === 'pv' || key === 'importPrice' || key === 'exportPrice') {
        nextData[key] = value as TimeSeries;
      }
    }

    try {
      validateData(nextData);
    } catch (validationError) {
      const msg = validationError instanceof Error ? validationError.message : String(validationError);
      return next(toHttpError(validationError, 400, msg));
    }

    try {
      await saveData(nextData);
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

export default router;
