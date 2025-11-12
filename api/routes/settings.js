import express from 'express';

import { toHttpError } from '../http-errors.js';
import {
  getAlgorithmSettings,
  getSystemSettings,
  getTimeSeriesSettings,
  saveAlgorithmSettings,
  saveSystemSettings,
  saveTimeSeriesSettings,
} from '../services/settings-store.js';

const router = express.Router();

router.get('/system', async (_req, res, next) => {
  try {
    const settings = await getSystemSettings();
    res.json(settings);
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read system settings'));
  }
});

router.post('/system', async (req, res, next) => {
  try {
    await saveSystemSettings(req.body ?? {});
    res.json({ message: 'System settings saved successfully.' });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to save system settings'));
  }
});

router.get('/algorithm', async (_req, res, next) => {
  try {
    const settings = await getAlgorithmSettings();
    res.json(settings);
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read algorithm settings'));
  }
});

router.post('/algorithm', async (req, res, next) => {
  try {
    await saveAlgorithmSettings(req.body ?? {});
    res.json({ message: 'Algorithm settings saved successfully.' });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to save algorithm settings'));
  }
});

router.get('/time-series', async (_req, res, next) => {
  try {
    const settings = await getTimeSeriesSettings();
    res.json(settings);
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read time series settings'));
  }
});

router.post('/time-series', async (req, res, next) => {
  try {
    await saveTimeSeriesSettings(req.body ?? {});
    res.json({ message: 'Time series settings saved successfully.' });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to save time series settings'));
  }
});

router.get('/', async (_req, res, next) => {
  try {
    const [system, algorithm, timeseries] = await Promise.all([
      getSystemSettings(),
      getAlgorithmSettings(),
      getTimeSeriesSettings(),
    ]);
    res.json({ ...system, ...algorithm, ...timeseries });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read settings'));
  }
});

router.post('/', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    await Promise.all([
      saveSystemSettings(body),
      saveAlgorithmSettings(body),
      saveTimeSeriesSettings(body),
    ]);
    res.json({ message: 'Settings saved successfully.' });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to save settings'));
  }
});

export default router;
