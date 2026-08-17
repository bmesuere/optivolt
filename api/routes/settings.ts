import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { assertCondition, toHttpError } from '../http-errors.ts';
import { loadSettings, saveSettings } from '../services/settings-store.ts';
import { HA_TOKEN_SENTINEL, redactSettingsForClient } from '../settings-redaction.ts';
import {
  buildPredictionRunConfig,
  runCombinedPredictionForecast,
} from '../services/prediction-forecast-runner.ts';
import type { Settings } from '../types.ts';

const router = express.Router();

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = await loadSettings();
    res.json({ ...redactSettingsForClient(settings), isAddon: !!process.env.SUPERVISOR_TOKEN });
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
    if (incoming.haToken === HA_TOKEN_SENTINEL) {
      incoming.haToken = prevSettings.haToken;
    }
    const mergedSettings = { ...prevSettings, ...incoming };
    await saveSettings(mergedSettings);

    // Re-read so the comparison uses the normalized value (clamping and
    // rounding happen on load, not on save).
    const savedSettings = await loadSettings();
    let forecastsRefreshed = false;
    if (savedSettings.extendedHorizonDays !== prevSettings.extendedHorizonDays) {
      forecastsRefreshed = await refreshForecastsForNewHorizon(savedSettings);
    }

    // Reported so the client can re-read the stored series: the Predictions tab
    // caches them, and would otherwise show the old window until a manual
    // forecast run or a page reload.
    res.json({ message: 'Settings saved successfully.', settings: redactSettingsForClient(mergedSettings), forecastsRefreshed });
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

export default router;
