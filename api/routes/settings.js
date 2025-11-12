import express from 'express';

import { assertCondition, toHttpError } from '../http-errors.js';
import {
  CATEGORY_NAMES,
  loadSettings,
  loadSettingsCategory,
  replaceSettings,
  updateSettings,
  updateSettingsCategory,
} from '../settings-store.js';

const router = express.Router();

function ensurePlainObject(value) {
  assertCondition(value && typeof value === 'object' && !Array.isArray(value), 400, 'settings payload must be an object');
}

router.get('/', async (_req, res, next) => {
  try {
    const settings = await loadSettings();
    res.json(settings);
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read settings'));
  }
});

async function handleReplace(req, res, next) {
  try {
    const payload = req.body ?? {};
    ensurePlainObject(payload);

    const updated = await replaceSettings(payload);
    res.json(updated);
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to save settings'));
  }
}

router.put('/', handleReplace);
router.post('/', handleReplace);

router.patch('/', async (req, res, next) => {
  try {
    const payload = req.body ?? {};
    ensurePlainObject(payload);

    const updated = await updateSettings(payload);
    res.json(updated);
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to save settings'));
  }
});

router.get('/:category', async (req, res, next) => {
  try {
    const { category } = req.params;
    assertCondition(CATEGORY_NAMES.includes(category), 404, 'Unknown settings category');

    const settings = await loadSettingsCategory(category);
    res.json(settings);
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read settings'));
  }
});

router.put('/:category', async (req, res, next) => {
  try {
    const { category } = req.params;
    assertCondition(CATEGORY_NAMES.includes(category), 404, 'Unknown settings category');

    const payload = req.body ?? {};
    ensurePlainObject(payload);

    const updated = await updateSettingsCategory(category, payload);
    res.json(updated);
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to save settings'));
  }
});

export default router;
