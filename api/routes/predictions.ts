import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { HttpError, assertCondition, toHttpError } from '../http-errors.ts';
import { loadPredictionConfig, savePredictionConfig } from '../services/prediction-config-store.ts';
// @ts-ignore - prediction-service.js is not yet converted to TypeScript
import { runValidation, runForecast } from '../services/prediction-service.js';
import { loadData, saveData } from '../services/data-store.ts';
import { loadSettings } from '../services/settings-store.ts';
import type { PredictionConfig } from '../types.ts';

const router = express.Router();

router.get('/config', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await loadPredictionConfig();
    res.json({
      ...config,
      isAddon: !!process.env.SUPERVISOR_TOKEN,
    });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read prediction config'));
  }
});

router.post('/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const incoming = req.body ?? {};
    assertCondition(
      incoming && typeof incoming === 'object' && !Array.isArray(incoming),
      400,
      'prediction config payload must be an object',
    );

    const prev = await loadPredictionConfig();
    const merged = { ...prev, ...incoming };
    await savePredictionConfig(merged);

    res.json({ message: 'Prediction config saved.', config: merged });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to save prediction config'));
  }
});

router.post('/validate', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await loadPredictionConfig();

    assertCondition(
      !!process.env.SUPERVISOR_TOKEN || (config.haUrl.length > 0 && config.haToken.length > 0),
      400,
      'haUrl and haToken are required when not running as an add-on'
    );
    assertCondition(config.sensors.length > 0, 400, 'At least one sensor must be configured');

    logPredictionCall('validate', { sensors: config.sensors.length });

    let result;
    try {
      result = await runValidation(config);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('auth') || msg.includes('WebSocket') || msg.includes('timed out')) {
        throw toHttpError(err, 502, `HA connection error: ${msg}`);
      }
      throw err;
    }

    res.json(result);
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'Validation failed'));
  }
});

router.post('/forecast', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await loadPredictionConfig();

    if (req.query.recent === 'false') {
      config.includeRecent = false;
    }

    const result = await executeForecast(config, 'forecast');
    res.json(result);
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'Forecast failed'));
  }
});

router.get('/forecast/now', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await loadPredictionConfig();
    config.includeRecent = false;

    const result = await executeForecast(config, 'forecast/now');
    res.json(result);
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'Forecast failed'));
  }
});

async function executeForecast(config: PredictionConfig, logLabel: string): Promise<unknown> {
  assertCondition(
    !!process.env.SUPERVISOR_TOKEN || (config.haUrl.length > 0 && config.haToken.length > 0),
    400,
    'haUrl and haToken are required when not running as an add-on'
  );
  assertCondition(config.activeConfig != null, 400, 'activeConfig is required');
  assertCondition(config.sensors.length > 0, 400, 'At least one sensor must be configured');

  logPredictionCall(logLabel, { activeConfig: config.activeConfig });

  try {
    const result = await runForecast(config);

    if (result?.forecast?.values) {
      const settings = await loadSettings();
      if (settings.dataSources.load === 'api') {
        const currentData = await loadData();
        currentData.load = result.forecast;
        await saveData(currentData);
      }
    }

    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('auth') || msg.includes('WebSocket') || msg.includes('timed out')) {
      throw toHttpError(err, 502, `HA connection error: ${msg}`);
    }
    throw err;
  }
}

function logPredictionCall(type: string, meta: Record<string, unknown>): void {
  console.log(`[predict] ${type}`, {
    timestamp: new Date().toISOString(),
    ...meta,
  });
}

export default router;
