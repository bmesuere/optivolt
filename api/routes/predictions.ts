import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { HttpError, assertCondition, toHttpError } from '../http-errors.ts';
import { loadPredictionConfig, savePredictionConfig } from '../services/prediction-config-store.ts';
import { runValidation, runForecast } from '../services/load-prediction-service.ts';
import { runPvForecast } from '../services/pv-prediction-service.ts';
import { loadData, saveData } from '../services/data-store.ts';
import { loadSettings } from '../services/settings-store.ts';
import type { PredictionConfig, PredictionRunConfig } from '../types.ts';

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

    // haUrl/haToken are now stored in Settings, not prediction config — strip them
    const { haUrl: _haUrl, haToken: _haToken, ...rest } = incoming;
    const prev = await loadPredictionConfig();
    const merged = { ...prev, ...rest };
    await savePredictionConfig(merged);

    res.json({ message: 'Prediction config saved.', config: merged });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to save prediction config'));
  }
});

router.post('/validate', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await buildRunConfig();
    assertHaConnection(config);
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
    const config = await buildRunConfig();

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
    const config = await buildRunConfig();

    const result = await executePvForecast(config, 'pv/forecast');
    res.json(result);
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'PV forecast failed'));
  }
});

// ----------------------------- Combined forecast --------------------------

router.post('/forecast', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await buildRunConfig();

    if (req.query.recent === 'false') {
      config.includeRecent = false;
    }

    const [loadResult, pvResult] = await Promise.all([
      executeLoadForecast(config, 'forecast').catch(handleCombinedForecastError('load')),
      executePvForecast(config, 'forecast').catch(handleCombinedForecastError('pv')),
    ]);

    res.json({ load: loadResult, pv: pvResult });
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'Forecast failed'));
  }
});

router.get('/forecast/now', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await buildRunConfig();
    config.includeRecent = false;

    const [loadResult, pvResult] = await Promise.all([
      executeLoadForecast(config, 'forecast/now').catch(handleCombinedForecastError('load', 'forecast/now')),
      executePvForecast(config, 'forecast/now').catch(handleCombinedForecastError('pv', 'forecast/now')),
    ]);

    res.json({ load: loadResult, pv: pvResult });
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'Forecast failed'));
  }
});

// ----------------------------- Helpers ------------------------------------

async function buildRunConfig(): Promise<PredictionRunConfig> {
  const [config, settings] = await Promise.all([loadPredictionConfig(), loadSettings()]);
  return { ...config, haUrl: settings.haUrl, haToken: settings.haToken };
}

async function executeLoadForecast(config: PredictionRunConfig, logLabel: string): Promise<unknown> {
  assertCondition(config.activeType != null, 400, 'activeType is required');
  if (config.activeType === 'historical') {
    assertHaConnection(config);
    assertCondition(config.sensors.length > 0, 400, 'At least one sensor must be configured');
    assertCondition(config.historicalPredictor != null, 400, 'historicalPredictor is required for historical activeType');
  }
  if (config.activeType === 'fixed') {
    assertCondition(config.fixedPredictor != null, 400, 'fixedPredictor is required for fixed activeType');
    assertCondition(
      Number.isFinite(config.fixedPredictor!.load_W) && config.fixedPredictor!.load_W >= 0,
      400,
      'fixedPredictor.load_W must be a non-negative finite number'
    );
  }

  logPredictionCall(logLabel + ' (load)', { activeType: config.activeType });

  try {
    const result = await runForecast(config);
    await maybeSaveForecastData('load', result?.forecast);
    return result;
  } catch (err) {
    throw mapPredictionError(err, false);
  }
}

async function executePvForecast(config: PredictionRunConfig, logLabel: string): Promise<unknown> {
  if (
    !config.pvConfig ||
    config.pvConfig.latitude == null || Number.isNaN(config.pvConfig.latitude) ||
    config.pvConfig.longitude == null || Number.isNaN(config.pvConfig.longitude)
  ) {
    return null;
  }

  assertHaConnection(config);
  assertCondition(config.sensors.length > 0, 400, 'At least one sensor must be configured');

  logPredictionCall(logLabel + ' (pv)', { pvConfig: config.pvConfig });

  try {
    const result = await runPvForecast(config);
    await maybeSaveForecastData('pv', result?.forecast);
    return result;
  } catch (err) {
    throw mapPredictionError(err, true);
  }
}

function logPredictionCall(type: string, meta: Record<string, unknown>): void {
  console.log(`[predict] ${type}`, {
    timestamp: new Date().toISOString(),
    ...meta,
  });
}

function assertHaConnection(config: PredictionRunConfig): void {
  assertCondition(
    !!process.env.SUPERVISOR_TOKEN || (config.haUrl.length > 0 && config.haToken.length > 0),
    400,
    'haUrl and haToken are required when not running as an add-on'
  );
}

function handleCombinedForecastError(type: string, logLabel: string = 'combined') {
  return (err: Error) => {
    console.warn(`[predict] ${type} forecast failed in ${logLabel}:`, err.message);
    return null;
  };
}

async function maybeSaveForecastData(type: 'load' | 'pv', forecast: any) {
  if (!forecast?.values) return;
  const settings = await loadSettings();
  if (settings.dataSources[type] === 'api') {
    const currentData = await loadData();
    currentData[type] = forecast;
    await saveData(currentData);
  }
}

function mapPredictionError(err: unknown, isPv: boolean): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (isPv && msg.includes('Open-Meteo')) {
    return toHttpError(err, 502, `Open-Meteo error: ${msg}`);
  }
  if (msg.includes('auth') || msg.includes('WebSocket') || msg.includes('timed out') || msg.includes('connection refused')) {
    return toHttpError(err, 502, `HA connection error: ${msg}`);
  }
  return err instanceof Error ? err : new Error(msg);
}

export default router;
