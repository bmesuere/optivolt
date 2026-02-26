import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { HttpError, assertCondition, toHttpError } from '../http-errors.ts';
import { loadPredictionConfig, savePredictionConfig } from '../services/prediction-config-store.ts';
import { runValidation, runForecast } from '../services/prediction-service.ts';
import { runPvForecast } from '../services/pv-prediction-service.ts';
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

// ----------------------------- Load forecast ------------------------------

router.post('/load/forecast', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await loadPredictionConfig();

    if (req.query.recent === 'false') {
      config.includeRecent = false;
    }

    const result = await executeLoadForecast(config, 'load/forecast');
    res.json(result);
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'Load forecast failed'));
  }
});

// ----------------------------- PV forecast --------------------------------

router.post('/pv/forecast', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await loadPredictionConfig();

    const result = await executePvForecast(config, 'pv/forecast');
    res.json(result);
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'PV forecast failed'));
  }
});

// ----------------------------- Combined forecast --------------------------

router.post('/forecast', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await loadPredictionConfig();

    if (req.query.recent === 'false') {
      config.includeRecent = false;
    }

    const [loadResult, pvResult] = await Promise.all([
      executeLoadForecast(config, 'forecast').catch(err => {
        console.warn('[predict] load forecast failed in combined:', err.message);
        return null;
      }),
      executePvForecast(config, 'forecast').catch(err => {
        console.warn('[predict] pv forecast failed in combined:', err.message);
        return null;
      }),
    ]);

    res.json({ load: loadResult, pv: pvResult });
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'Forecast failed'));
  }
});

router.get('/forecast/now', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await loadPredictionConfig();
    config.includeRecent = false;

    const [loadResult, pvResult] = await Promise.all([
      executeLoadForecast(config, 'forecast/now').catch(err => {
        console.warn('[predict] load forecast failed in forecast/now:', err.message);
        return null;
      }),
      executePvForecast(config, 'forecast/now').catch(err => {
        console.warn('[predict] pv forecast failed in forecast/now:', err.message);
        return null;
      }),
    ]);

    res.json({ load: loadResult, pv: pvResult });
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'Forecast failed'));
  }
});

// ----------------------------- Helpers ------------------------------------

async function executeLoadForecast(config: PredictionConfig, logLabel: string): Promise<unknown> {
  assertCondition(
    !!process.env.SUPERVISOR_TOKEN || (config.haUrl.length > 0 && config.haToken.length > 0),
    400,
    'haUrl and haToken are required when not running as an add-on'
  );
  assertCondition(config.activeConfig != null, 400, 'activeConfig is required');
  assertCondition(config.sensors.length > 0, 400, 'At least one sensor must be configured');

  logPredictionCall(logLabel + ' (load)', { activeConfig: config.activeConfig });

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

async function executePvForecast(config: PredictionConfig, logLabel: string): Promise<unknown> {
  if (!config.pvConfig || !config.pvConfig.latitude || !config.pvConfig.longitude) {
    return null;
  }

  assertCondition(
    !!process.env.SUPERVISOR_TOKEN || (config.haUrl.length > 0 && config.haToken.length > 0),
    400,
    'haUrl and haToken are required when not running as an add-on'
  );
  assertCondition(config.sensors.length > 0, 400, 'At least one sensor must be configured');

  logPredictionCall(logLabel + ' (pv)', { pvConfig: config.pvConfig });

  try {
    const result = await runPvForecast(config);

    if (result?.forecast?.values) {
      const settings = await loadSettings();
      if (settings.dataSources.pv === 'api') {
        const currentData = await loadData();
        currentData.pv = result.forecast;
        await saveData(currentData);
      }
    }

    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Open-Meteo')) {
      throw toHttpError(err, 502, `Open-Meteo error: ${msg}`);
    }
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
