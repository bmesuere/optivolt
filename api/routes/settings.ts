import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { assertCondition, toHttpError } from '../http-errors.ts';
import {
  loadSettings,
  saveSettings,
  loadDefaultSettings,
  SettingsValidationError,
} from '../services/settings-store.ts';
import {
  buildPredictionRunConfig,
  runCombinedPredictionForecast,
} from '../services/prediction-forecast-runner.ts';
import type { Settings } from '../types.ts';

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
    const payload = req.body ?? {};
    assertCondition(
      payload && typeof payload === 'object' && !Array.isArray(payload),
      400,
      'settings payload must be an object',
    );

    const incoming = pickKnownKeys(payload, await loadDefaultSettings());

    const prevSettings = await loadSettings();
    const mergedSettings = {
      ...prevSettings,
      ...incoming,
      dataSources: { ...prevSettings.dataSources, ...incoming.dataSources },
    };
    try {
      await saveSettings(mergedSettings);
    } catch (error) {
      if (error instanceof SettingsValidationError) throw toHttpError(error, 400);
      throw error;
    }

    // Re-read so the response and the horizon comparison use the clamped form.
    const savedSettings = await loadSettings();
    let forecastsRefreshed = false;
    if (savedSettings.extendedHorizonDays !== prevSettings.extendedHorizonDays) {
      forecastsRefreshed = await refreshForecastsForNewHorizon(savedSettings);
    }

    // Reported so the client can re-read the stored series: the Predictions tab
    // caches them, and would otherwise show the old window until a manual
    // forecast run or a page reload.
    res.json({ message: 'Settings saved successfully.', settings: savedSettings, forecastsRefreshed });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to save settings'));
  }
});

/**
 * The load and PV forecasts are generated over the configured horizon, but are
 * otherwise only refreshed out-of-band (an HA cron hitting /predictions/forecast).
 * A plan can never run past its data, so after a horizon change the stored
 * series would cap the plan at the old window until that cron next fires.
 * Regenerate them here instead.
 *
 * Awaited so the recompute that follows a settings change sees the new series.
 * Failures are logged, not surfaced: the settings are already saved, and the
 * next scheduled run recovers.
 */
async function refreshForecastsForNewHorizon(settings: Settings): Promise<boolean> {
  // Only these sources are written by the forecast runner; skip the external
  // calls entirely when neither applies.
  if (settings.dataSources.load !== 'api' && settings.dataSources.pv !== 'api') return false;
  try {
    const config = await buildPredictionRunConfig();
    await runCombinedPredictionForecast(config, 'horizon-change');
    return true;
  } catch (error) {
    console.warn(
      '[settings] forecast refresh after horizon change failed:',
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

/** Drop keys absent from the known Settings shape (the defaults object), including nested dataSources keys. */
function pickKnownKeys(payload: Record<string, unknown>, defaults: Settings): Partial<Settings> {
  const picked: Record<string, unknown> = {};
  for (const key of Object.keys(defaults)) {
    if (!Object.hasOwn(payload, key)) continue;
    picked[key] = payload[key];
  }

  const dataSources = picked.dataSources;
  if (dataSources && typeof dataSources === 'object' && !Array.isArray(dataSources)) {
    const filtered: Record<string, unknown> = {};
    for (const key of Object.keys(defaults.dataSources)) {
      if (!Object.hasOwn(dataSources as Record<string, unknown>, key)) continue;
      filtered[key] = (dataSources as Record<string, unknown>)[key];
    }
    picked.dataSources = filtered;
  } else if (dataSources !== undefined) {
    delete picked.dataSources;
  }

  return picked as Partial<Settings>;
}

export default router;
