/**
 * prediction-service.js
 *
 * Orchestrates HA data fetch → postprocess → predict/validate.
 */

import { fetchHaStats } from './ha-client.js';
import { postprocess, getSensorNames } from '../../lib/ha-postprocess.js';
import {
  predict,
  validate,
  generateAllConfigs,
  buildForecastSeriesRange,
} from '../../lib/predict-load.js';

/**
 * Run full validation across all config combinations.
 *
 * @param {Object} config  prediction config (haUrl, haToken, historyStart, sensors, derived, validationWindow)
 * @returns {{ sensorNames: string[], results: Array }}
 */
export async function runValidation(config) {
  const { haUrl, haToken, sensors, derived, validationWindow } = config;
  const entityIds = sensors.map(s => s.id);

  // Max lookback tested by generateAllConfigs is 8 weeks; +1 week for the validation window
  const MAX_LOOKBACK_WEEKS = 8;
  const startTime = new Date(Date.now() - (MAX_LOOKBACK_WEEKS + 1) * 7 * 24 * 60 * 60 * 1000).toISOString();

  const rawData = await fetchHaStats({
    haUrl,
    haToken,
    entityIds,
    startTime,
  });

  const data = postprocess(rawData, sensors, derived);
  const sensorNames = getSensorNames(data);
  const allConfigs = generateAllConfigs(sensorNames);

  const results = [];
  for (const cfg of allConfigs) {
    const predictions = predict(data, cfg);
    const metrics = validate(predictions, validationWindow);

    // Only include validation-window predictions for chart rendering
    const windowStart = new Date(validationWindow.start).getTime();
    const windowEnd = new Date(validationWindow.end).getTime();

    const validationPredictions = predictions.filter(
      p => p.time >= windowStart && p.time < windowEnd
    );

    results.push({
      sensor: cfg.sensor,
      lookbackWeeks: cfg.lookbackWeeks,
      dayFilter: cfg.dayFilter,
      aggregation: cfg.aggregation,
      mae: metrics.mae,
      rmse: metrics.rmse,
      mape: metrics.mape,
      n: metrics.n,
      nSkipped: metrics.nSkipped,
      validationPredictions,
    });
  }

  return { sensorNames, results };
}

/**
 * Run forecast for tomorrow using the active config.
 *
 * @param {Object} config  prediction config with activeConfig set
 * @returns {{ start: string, step: number, values: number[] }}
 */
export async function runForecast(config) {
  const { haUrl, haToken, sensors, derived, activeConfig } = config;
  const entityIds = sensors.map(s => s.id);

  // +1 week when we need recent accuracy for the UI chart
  const extraWeeks = config.includeRecent !== false ? 1 : 0;
  const totalWeeks = activeConfig.lookbackWeeks + extraWeeks;
  const startTime = new Date(Date.now() - totalWeeks * 7 * 24 * 60 * 60 * 1000).toISOString();

  const rawData = await fetchHaStats({
    haUrl,
    haToken,
    entityIds,
    startTime,
  });

  const data = postprocess(rawData, sensors, derived);

  // Forecast duration:
  // < 13:00 -> until midnight tonight
  // >= 13:00 -> until midnight tomorrow
  const now = new Date();
  const currentHour = now.getHours();

  const end = new Date(now);
  end.setMinutes(0, 0, 0);
  if (currentHour < 13) {
    end.setDate(end.getDate() + 1);
    end.setHours(0, 0, 0, 0);
  } else {
    end.setDate(end.getDate() + 2);
    end.setHours(0, 0, 0, 0);
  }

  // Define targets:
  // 1. Recent (past 7 days) for validation/chart context
  // 2. Future (from next hour to end) for forecast

  const recentStart = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const recentEnd = now.getTime();

  // Filter history for recent targets (ensure we only target the active sensor)
  const recentTargets = data.filter(d =>
    d.sensor === activeConfig.sensor &&
    d.time >= recentStart &&
    d.time <= recentEnd
  );

  // Generate future targets
  const futureTargets = [];
  const futureStart = Math.floor(now.getTime() / 3600000) * 3600000;
  const futureEnd = end.getTime();

  for (let t = futureStart; t < futureEnd; t += 3600000) {
    const d = new Date(t);
    futureTargets.push({
      date: d.toISOString(),
      time: t,
      hour: d.getHours(),
      dayOfWeek: d.getDay(),
      value: null
    });
  }

  const allTargets = [...recentTargets, ...futureTargets];
  const predictions = predict(data, activeConfig, allTargets);

  // Align start to recent 15m slot
  const startMs = Math.floor(now.getTime() / (15 * 60 * 1000)) * (15 * 60 * 1000);
  const startIso = new Date(startMs).toISOString();
  const endIso = end.toISOString();

  const forecastSeries = buildForecastSeriesRange(predictions, startIso, endIso);

  // Recent accuracy (optional)
  let recent = [];
  if (config.includeRecent !== false) {
    const recentEnd = Date.now();
    const past7d = recentEnd - 7 * 24 * 60 * 60 * 1000;

    recent = predictions
      .filter(p => p.time <= recentEnd && p.time >= past7d)
      .map(p => ({
        date: p.date,
        time: p.time,
        hour: p.hour,
        actual: p.actual,
        predicted: p.predicted,
      }));
  }

  return { forecast: forecastSeries, recent };
}
