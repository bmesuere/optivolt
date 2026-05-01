import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { HttpError, assertCondition, toHttpError } from '../http-errors.ts';
import { loadPredictionConfig, savePredictionConfig } from '../services/prediction-config-store.ts';
import type { PredictionAdjustmentInput } from '../services/prediction-adjustments.ts';
import {
  createStoredPredictionAdjustment,
  deleteStoredPredictionAdjustment,
  loadActiveAdjustmentsAndPrune,
  updateStoredPredictionAdjustment,
} from '../services/prediction-adjustment-store.ts';
import {
  buildPredictionRunConfig,
  executeLoadForecast,
  executePredictionValidation,
  executePvForecast,
  persistForecastData,
  runCombinedPredictionForecast,
  withAdjustedForecast,
} from '../services/prediction-forecast-runner.ts';

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

    // haUrl/haToken are stored in settings, not prediction config.
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

    const result = await createStoredPredictionAdjustment(req.body as PredictionAdjustmentInput);
    res.status(201).json(result);
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

    const result = await updateStoredPredictionAdjustment(String(req.params.id), req.body as PredictionAdjustmentInput);
    res.json(result);
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'Failed to update prediction adjustment'));
  }
});

router.delete('/adjustments/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await deleteStoredPredictionAdjustment(String(req.params.id)));
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'Failed to delete prediction adjustment'));
  }
});

router.post('/validate', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await buildPredictionRunConfig();
    res.json(await executePredictionValidation(config));
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'Validation failed'));
  }
});

// ----------------------------- Load forecast ------------------------------

router.post('/load/forecast', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await buildPredictionRunConfig();

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

router.post('/pv/forecast', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await buildPredictionRunConfig();

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
    const config = await buildPredictionRunConfig();
    if (req.query.recent === 'false') config.includeRecent = false;
    res.json(await runCombinedPredictionForecast(config, 'forecast'));
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'Forecast failed'));
  }
});

router.get('/forecast/now', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await buildPredictionRunConfig();
    config.includeRecent = false;
    res.json(await runCombinedPredictionForecast(config, 'forecast/now'));
  } catch (error) {
    next(error instanceof HttpError ? error : toHttpError(error, 500, 'Forecast failed'));
  }
});

export default router;
