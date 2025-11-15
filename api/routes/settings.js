import express from 'express';
import { assertCondition, toHttpError } from '../http-errors.js';
import { loadSettings, saveSettings } from '../services/settings-store.js';

const router = express.Router();

router.get('/', async (_req, res, next) => {
  try {
    const settings = await loadSettings();
    res.json(settings || {});
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read settings'));
  }
});

router.post('/', async (req, res, next) => {
  try {
    const incoming = req.body ?? {};
    assertCondition(
      incoming && typeof incoming === 'object' && !Array.isArray(incoming),
      400,
      'settings payload must be an object',
    );

    const prevSettings = await loadSettings();
    const mergedSettings = { ...prevSettings, ...incoming };
    await saveSettings(mergedSettings);

    res.json({ message: 'Settings saved successfully.', settings: mergedSettings });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to save settings'));
  }
});

export default router;
