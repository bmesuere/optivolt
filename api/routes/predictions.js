import express from 'express';
import { assertCondition, toHttpError } from '../http-errors.js';
import { loadPredictionConfig, savePredictionConfig } from '../services/prediction-config-store.js';
import { runValidation, runForecast } from '../services/prediction-service.js';

const router = express.Router();

router.get('/config', async (_req, res, next) => {
  try {
    const config = await loadPredictionConfig();
    res.json(config);
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read prediction config'));
  }
});

router.post('/config', async (req, res, next) => {
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

router.post('/validate', async (req, res, next) => {
  try {
    const config = await loadPredictionConfig();

    assertCondition(config.haUrl, 400, 'haUrl is required');
    assertCondition(config.haToken, 400, 'haToken is required');
    assertCondition(config.sensors?.length > 0, 400, 'At least one sensor must be configured');

    logPredictionCall('validate', { sensors: config.sensors.length });

    let result;
    try {
      result = await runValidation(config);
    } catch (err) {
      const msg = err?.message ?? String(err);
      if (msg.includes('auth') || msg.includes('WebSocket') || msg.includes('timed out')) {
        throw toHttpError(err, 502, `HA connection error: ${msg}`);
      }
      throw err;
    }

    res.json(result);
  } catch (error) {
    next(error instanceof Error && error.statusCode ? error : toHttpError(error, 500, 'Validation failed'));
  }
});

router.post('/forecast', async (req, res, next) => {
  try {
    const config = await loadPredictionConfig();

    if (req.query.recent === 'false') {
      config.includeRecent = false;
    }

    const result = await executeForecast(config, 'forecast');
    res.json(result);
  } catch (error) {
    next(error instanceof Error && error.statusCode ? error : toHttpError(error, 500, 'Forecast failed'));
  }
});

// Automation endpoint: future slots only (no recent accuracy data)
router.get('/forecast/now', async (req, res, next) => {
  try {
    const config = await loadPredictionConfig();
    config.includeRecent = false;

    const result = await executeForecast(config, 'forecast/now');
    res.json(result);
  } catch (error) {
    next(error instanceof Error && error.statusCode ? error : toHttpError(error, 500, 'Forecast failed'));
  }
});

async function executeForecast(config, logLabel) {
  assertCondition(config.haUrl, 400, 'haUrl is required');
  assertCondition(config.haToken, 400, 'haToken is required');
  assertCondition(config.activeConfig, 400, 'activeConfig is required');
  assertCondition(config.sensors?.length > 0, 400, 'At least one sensor must be configured');

  logPredictionCall(logLabel, { activeConfig: config.activeConfig });

  try {
    return await runForecast(config);
  } catch (err) {
    const msg = err?.message ?? String(err);
    if (msg.includes('auth') || msg.includes('WebSocket') || msg.includes('timed out')) {
      throw toHttpError(err, 502, `HA connection error: ${msg}`);
    }
    throw err;
  }
}

function logPredictionCall(type, meta) {
  const timestamp = new Date().toISOString();
  console.log(`[predict] ${type}`, {
    timestamp,
    ...meta
  });
}

export default router;
