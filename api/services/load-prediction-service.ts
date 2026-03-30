/**
 * load-prediction-service.ts
 *
 * Orchestrates HA data fetch → postprocess → predict/validate.
 */

import { fetchHaStats } from './ha-client.ts';
import { postprocess, getSensorNames } from '../../lib/ha-postprocess.ts';
import type { StatRecord } from '../../lib/ha-postprocess.ts';
import {
  predict,
  validate,
  generateAllConfigs,
} from '../../lib/load-predictor-historical.ts';
import type { DayFilter, Aggregation } from '../../lib/load-predictor-historical.ts';
import type { PredictionRunConfig } from '../types.ts';
import { getForecastTimeRange, buildForecastSeries, computeErrorMetrics, type ForecastSeries, type PredictionResult } from '../../lib/time-series-utils.ts';

type PredictTarget = Pick<StatRecord, 'date' | 'time' | 'hour' | 'dayOfWeek'> & { value?: number | null };

interface ValidationEntry {
  sensor: string;
  lookbackWeeks: number;
  dayFilter: DayFilter;
  aggregation: Aggregation;
  mae: number;
  rmse: number;
  mape: number;
  n: number;
  nSkipped: number;
  validationPredictions: PredictionResult[];
}

interface ValidationRunResult {
  sensorNames: string[];
  results: ValidationEntry[];
}

interface ForecastRunResult {
  forecast: ForecastSeries;
  recent: PredictionResult[];
  metrics: { mae: number; rmse: number; mape: number; n: number };
}

/**
 * Run full validation across all config combinations.
 */
export async function runValidation(config: PredictionRunConfig): Promise<ValidationRunResult> {
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

  const results: ValidationEntry[] = [];
  for (const cfg of allConfigs) {
    const predictions = predict(data, cfg);
    // validationWindow is always set by loadPredictionConfig()
    const metrics = validate(predictions, validationWindow!);

    const windowStart = new Date(validationWindow!.start).getTime();
    const windowEnd = new Date(validationWindow!.end).getTime();

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
 * Caller must ensure config.activeType is set.
 */
export async function runForecast(config: PredictionRunConfig): Promise<ForecastRunResult> {
  const { activeType, historicalPredictor, fixedPredictor, haUrl, haToken, sensors, derived } = config;

  if (activeType === 'fixed') {
    const load_W = fixedPredictor!.load_W;
    const nowMs = Date.now();
    const { startIso, endIso } = getForecastTimeRange(nowMs);
    const startMs = new Date(startIso).getTime();
    const endMs = new Date(endIso).getTime();
    const nSlots = Math.round((endMs - startMs) / (15 * 60 * 1000));
    const forecast: ForecastSeries = { start: startIso, step: 15, values: Array(nSlots).fill(load_W) };

    const canComputeAccuracy =
      config.includeRecent !== false &&
      historicalPredictor?.sensor &&
      sensors.length > 0 &&
      (!!process.env.SUPERVISOR_TOKEN || (haUrl.length > 0 && haToken.length > 0));

    if (!canComputeAccuracy) {
      return { forecast, recent: [], metrics: { mae: NaN, rmse: NaN, mape: NaN, n: 0 } };
    }

    const past7d = nowMs - 7 * 24 * 60 * 60 * 1000;
    const matchingSensor = sensors.find(s => (s.name || s.id) === historicalPredictor!.sensor);
    const entityIds = matchingSensor ? [matchingSensor.id] : sensors.map(s => s.id);
    const rawData = await fetchHaStats({ haUrl, haToken, entityIds, startTime: new Date(past7d).toISOString() });
    const data = postprocess(rawData, sensors, derived);

    const recent: PredictionResult[] = data
      .filter(d => d.sensor === historicalPredictor!.sensor && d.time >= past7d)
      .map(d => ({
        date: d.date,
        time: d.time,
        hour: d.hour,
        actual: d.value ?? null,
        predicted: load_W,
      }));

    const metrics = computeErrorMetrics(recent, r => r.actual, r => r.predicted);
    return { forecast, recent, metrics };
  }

  const entityIds = sensors.map(s => s.id);

  const extraWeeks = config.includeRecent !== false ? 1 : 0;
  const totalWeeks = historicalPredictor!.lookbackWeeks + extraWeeks;
  const startTime = new Date(Date.now() - totalWeeks * 7 * 24 * 60 * 60 * 1000).toISOString();

  const rawData = await fetchHaStats({
    haUrl,
    haToken,
    entityIds,
    startTime,
  });

  const data = postprocess(rawData, sensors, derived);

  const now = new Date();
  const { startIso, endIso } = getForecastTimeRange(now.getTime());
  const end = new Date(endIso);

  const recentStart = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const recentEnd = now.getTime();

  const recentTargets = data.filter(d =>
    d.sensor === historicalPredictor!.sensor &&
    d.time >= recentStart &&
    d.time <= recentEnd
  );

  const futureTargets: PredictTarget[] = [];
  const futureStart = Math.floor(now.getTime() / 3600000) * 3600000;
  const futureEnd = end.getTime();

  for (let t = futureStart; t < futureEnd; t += 3600000) {
    const d = new Date(t);
    futureTargets.push({
      date: d.toISOString(),
      time: t,
      hour: d.getUTCHours(),
      dayOfWeek: d.getUTCDay(),
      value: null,
    });
  }

  const allTargets: PredictTarget[] = [...recentTargets, ...futureTargets];
  const predictions = predict(data, historicalPredictor!, allTargets);

  const mappedPoints = predictions.map(p => ({ time: p.time, value: p.predicted ?? 0 }));
  const forecastSeries = buildForecastSeries(mappedPoints, startIso, endIso);

  let recent: PredictionResult[] = [];
  if (config.includeRecent !== false) {
    const nowMs = now.getTime();
    const past7d = nowMs - 7 * 24 * 60 * 60 * 1000;

    recent = predictions
      .filter(p => p.time <= nowMs && p.time >= past7d)
      .map(p => ({
        date: p.date,
        time: p.time,
        hour: p.hour,
        actual: p.actual,
        predicted: p.predicted,
      }));
  }

  const metrics = computeErrorMetrics(recent, r => r.actual, r => r.predicted);

  return { forecast: forecastSeries, recent, metrics };
}
