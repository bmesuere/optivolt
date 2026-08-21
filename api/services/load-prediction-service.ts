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

export interface ForecastRunResult {
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
 * Run forecast for tomorrow by summing the outputs of all configured predictors.
 *
 * Fixed predictors contribute a constant to the forecast only; recent accuracy
 * compares the summed historical predictions against the summed actuals of the
 * historical predictors' sensors (fixed terms have no ground truth).
 */
export async function runForecast(config: PredictionRunConfig): Promise<ForecastRunResult> {
  const { haUrl, haToken, sensors, derived } = config;
  const predictors = config.predictors ?? [];

  const historical = predictors.filter(p => p.type === 'historical');
  const fixed_W = predictors
    .filter(p => p.type === 'fixed')
    .reduce((sum, p) => sum + p.load_W, 0);

  const nowMs = Date.now();
  const { startIso, endIso } = getForecastTimeRange(nowMs, config.extendedHorizonDays ?? 0);
  const noMetrics = { mae: NaN, rmse: NaN, mape: NaN, n: 0 };

  if (historical.length === 0) {
    const startMs = new Date(startIso).getTime();
    const endMs = new Date(endIso).getTime();
    const nSlots = Math.round((endMs - startMs) / (15 * 60 * 1000));
    const forecast: ForecastSeries = { start: startIso, step: 15, values: Array(nSlots).fill(fixed_W) };
    return { forecast, recent: [], metrics: noMetrics };
  }

  const includeRecent = config.includeRecent !== false;
  const extraWeeks = includeRecent ? 1 : 0;
  const maxLookbackWeeks = Math.max(...historical.map(p => p.lookbackWeeks));
  const startTime = new Date(nowMs - (maxLookbackWeeks + extraWeeks) * 7 * 24 * 60 * 60 * 1000).toISOString();

  const rawData = await fetchHaStats({
    haUrl,
    haToken,
    entityIds: sensors.map(s => s.id),
    startTime,
  });

  const data = postprocess(rawData, sensors, derived);

  const recentStart = nowMs - 7 * 24 * 60 * 60 * 1000;
  const futureStart = Math.floor(nowMs / 3600000) * 3600000;
  const futureEnd = new Date(endIso).getTime();

  const futureTargets: PredictTarget[] = [];
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

  // Forecast: per-slot sum of each predictor's future predictions (null → 0),
  // plus the fixed terms.
  const perPredictorFuture = historical.map(p => predict(data, p, futureTargets));
  const mappedPoints = futureTargets.map((t, i) => ({
    time: t.time,
    value: fixed_W + perPredictorFuture.reduce((sum, predictions) => sum + (predictions[i].predicted ?? 0), 0),
  }));
  const forecastSeries = buildForecastSeries(mappedPoints, startIso, endIso);

  // Recent accuracy: sum per slot across predictors, only where every predictor
  // has an entry; a null component makes the slot's sum null.
  let recent: PredictionResult[] = [];
  if (includeRecent) {
    const recentMaps = historical.map(p => {
      const recentTargets = data.filter(d => d.sensor === p.sensor && d.time >= recentStart && d.time <= nowMs);
      return new Map(predict(data, p, recentTargets).map(r => [r.time, r]));
    });
    const times = [...recentMaps[0].keys()]
      .filter(time => recentMaps.every(m => m.has(time)))
      .sort((a, b) => a - b);

    recent = times.map(time => {
      const entries = recentMaps.map(m => m.get(time)!);
      const sumOrNull = (values: Array<number | null>) =>
        values.some(v => v == null) ? null : values.reduce((s: number, v) => s + v!, 0);
      return {
        date: entries[0].date,
        time,
        hour: entries[0].hour,
        actual: sumOrNull(entries.map(e => e.actual)),
        predicted: sumOrNull(entries.map(e => e.predicted)),
      };
    });
  }

  const metrics = recent.length > 0
    ? computeErrorMetrics(recent, r => r.actual, r => r.predicted)
    : noMetrics;

  return { forecast: forecastSeries, recent, metrics };
}
