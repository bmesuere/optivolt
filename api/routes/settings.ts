import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { assertCondition, toHttpError } from '../http-errors.ts';
import { loadSettings, saveSettings } from '../services/settings-store.ts';

const router = express.Router();

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = await loadSettings();
    res.json({ ...settings, isAddon: !!process.env.SUPERVISOR_TOKEN });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read settings'));
  }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
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
