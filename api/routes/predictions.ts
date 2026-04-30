import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { HttpError, assertCondition, toHttpError } from '../http-errors.ts';
import { loadPredictionConfig, savePredictionConfig } from '../services/prediction-config-store.ts';
import { runValidation, runForecast } from '../services/load-prediction-service.ts';
import type { ForecastRunResult } from '../services/load-prediction-service.ts';
import { runPvForecast } from '../services/pv-prediction-service.ts';
import type { PvForecastRunResult } from '../services/pv-prediction-service.ts';
import { loadData, saveData } from '../services/data-store.ts';
import { loadSettings } from '../services/settings-store.ts';
import type { PredictionAdjustmentSeries, PredictionConfig, PredictionRunConfig, TimeSeries } from '../types.ts';
import type { PredictionAdjustmentInput } from '../services/prediction-adjustments.ts';
import {
  applyPredictionAdjustmentsToSeries,
  createPredictionAdjustment,
  pruneExpiredPredictionAdjustments,
  updatePredictionAdjustment,
} from '../services/prediction-adjustments.ts';

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

// ----------------------------- Manual adjustments ------------------------

router.get('/adjustments', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { adjustments } = await loadActiveAdjustmentsAndPrune();
    res.json({ adjustments });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read prediction adjustments'));
  }
});

router.post('/adjustments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    assertCondition(
      req.body && typeof req.body === 'object' && !Array.isArray(req.body),
      400,
      'prediction adjustment payload must be an object',
    );

    const data = await loadData();
    const { data: pruned } = pruneExpiredPredictionAdjustments(data);
    const adjustment = createPredictionAdjustment(req.body as PredictionAdjustmentInput);
    const adjustments = [...(pruned.predictionAdjustments ?? []), adjustment];
    const nextData = { ...pruned, predictionAdjustments: adjustments };
    await saveData(nextData);
    res.status(201).json({ adjustment, adjustments });
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'Failed to create prediction adjustment'));
  }
});

router.patch('/adjustments/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    assertCondition(
      req.body && typeof req.body === 'object' && !Array.isArray(req.body),
      400,
      'prediction adjustment payload must be an object',
    );

    const data = await loadData();
    const { data: pruned } = pruneExpiredPredictionAdjustments(data);
    const adjustments = pruned.predictionAdjustments ?? [];
    const index = adjustments.findIndex(adj => adj.id === req.params.id);
    assertCondition(index >= 0, 404, 'Prediction adjustment not found');

    const updated = updatePredictionAdjustment(adjustments[index], req.body as PredictionAdjustmentInput);
    const nextAdjustments = adjustments.map((adj, i) => i === index ? updated : adj);
    const nextData = { ...pruned, predictionAdjustments: nextAdjustments };
    await saveData(nextData);
    res.json({ adjustment: updated, adjustments: nextAdjustments });
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'Failed to update prediction adjustment'));
  }
});

router.delete('/adjustments/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await loadData();
    const { data: pruned } = pruneExpiredPredictionAdjustments(data);
    const adjustments = pruned.predictionAdjustments ?? [];
    const nextAdjustments = adjustments.filter(adj => adj.id !== req.params.id);
    assertCondition(nextAdjustments.length !== adjustments.length, 404, 'Prediction adjustment not found');

    const nextData = { ...pruned, predictionAdjustments: nextAdjustments };
    await saveData(nextData);
    res.json({ adjustments: nextAdjustments });
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'Failed to delete prediction adjustment'));
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
    await persistForecastData({ load: result.forecast });
    res.json(await withAdjustedForecast(result, 'load'));
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'Load forecast failed'));
  }
});

// ----------------------------- PV forecast --------------------------------

router.post('/pv/forecast', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await buildRunConfig();

    const result = await executePvForecast(config, 'pv/forecast');
    await persistForecastData({ pv: result?.forecast });
    res.json(await withAdjustedForecast(result, 'pv'));
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'PV forecast failed'));
  }
});

// ----------------------------- Combined forecast --------------------------

router.post('/forecast', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await buildRunConfig();
    if (req.query.recent === 'false') config.includeRecent = false;
    res.json(await runCombinedForecast(config, 'forecast'));
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'Forecast failed'));
  }
});

router.get('/forecast/now', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await buildRunConfig();
    config.includeRecent = false;
    res.json(await runCombinedForecast(config, 'forecast/now'));
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'Forecast failed'));
  }
});

// ----------------------------- Helpers ------------------------------------

async function buildRunConfig(): Promise<PredictionRunConfig> {
  const [config, settings] = await Promise.all([loadPredictionConfig(), loadSettings()]);
  return { ...config, haUrl: settings.haUrl, haToken: settings.haToken };
}

async function runCombinedForecast(config: PredictionRunConfig, endpoint: string) {
  const [loadResult, pvResult] = await Promise.all([
    executeLoadForecast(config, endpoint).catch(handleCombinedForecastError('load', endpoint)),
    executePvForecast(config, endpoint).catch(handleCombinedForecastError('pv', endpoint)),
  ]);
  try {
    await persistForecastData({ load: loadResult?.forecast, pv: pvResult?.forecast });
  } catch (err) {
    console.warn('[predict] forecast persistence failed:', err instanceof Error ? err.message : err);
  }
  const { adjustments } = await loadActiveAdjustmentsAndPrune();
  return {
    load: applyForecastAdjustments(loadResult, 'load', adjustments),
    pv: applyForecastAdjustments(pvResult, 'pv', adjustments),
  };
}

async function executeLoadForecast(config: PredictionRunConfig, logLabel: string): Promise<ForecastRunResult> {
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
    return result;
  } catch (err) {
    throw mapPredictionError(err, false);
  }
}

async function executePvForecast(config: PredictionRunConfig, logLabel: string): Promise<PvForecastRunResult | null> {
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

async function persistForecastData(updates: { load?: TimeSeries; pv?: TimeSeries }) {
  if (!updates.load?.values && !updates.pv?.values) return;
  const settings = await loadSettings();
  const setLoad = !!updates.load?.values && settings.dataSources.load === 'api';
  const setPv   = !!updates.pv?.values   && settings.dataSources.pv   === 'api';
  if (!setLoad && !setPv) return;
  const data = await loadData();
  if (setLoad) data.load = updates.load!;
  if (setPv)   data.pv   = updates.pv!;
  await saveData(data);
}

async function loadActiveAdjustmentsAndPrune() {
  const data = await loadData();
  const pruned = pruneExpiredPredictionAdjustments(data);
  if (pruned.changed) await saveData(pruned.data);
  return { data: pruned.data, adjustments: pruned.adjustments };
}

function applyForecastAdjustments<T extends { forecast?: TimeSeries } | null>(
  result: T,
  series: PredictionAdjustmentSeries,
  adjustments: ReturnType<typeof pruneExpiredPredictionAdjustments>['adjustments'],
): (T & { rawForecast?: TimeSeries }) | T {
  if (!result?.forecast) return result;
  const rawForecast = result.forecast;
  return {
    ...result,
    rawForecast,
    forecast: applyPredictionAdjustmentsToSeries(rawForecast, adjustments, series),
  };
}

async function withAdjustedForecast<T extends { forecast?: TimeSeries } | null>(
  result: T,
  series: PredictionAdjustmentSeries,
): Promise<(T & { rawForecast?: TimeSeries }) | T> {
  const { adjustments } = await loadActiveAdjustmentsAndPrune();
  return applyForecastAdjustments(result, series, adjustments);
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
