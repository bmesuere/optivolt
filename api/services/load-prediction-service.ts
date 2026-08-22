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
import {
  buildTemperatureAnchors,
  computeDayMeanTemps,
  computeEffectiveDayTemps,
  generateTemperatureConfigs,
  predictTemperatureLoad,
  predictTemperatureLoadRolling,
  summarizeTemperatureDays,
} from '../../lib/load-predictor-temperature.ts';
import { fetchTemperatureSeries } from './open-meteo-client.ts';
import type { HistoricalLoadPredictor, PredictionRunConfig, TemperatureLoadPredictor } from '../types.ts';
import { getForecastTimeRange, buildForecastSeries, computeErrorMetrics, type ForecastSeries, type PredictionResult } from '../../lib/time-series-utils.ts';

type PredictTarget = Pick<StatRecord, 'date' | 'time' | 'hour' | 'dayOfWeek'> & { value?: number | null };

interface ValidationEntry {
  type: 'historical' | 'temperature';
  sensor: string;
  lookbackWeeks: number;
  dayFilter: DayFilter;
  aggregation?: Aggregation;
  bins?: number;
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
 * True when pvConfig carries usable coordinates. (0, 0) is rejected as the
 * "cleared fields" sentinel older versions of the config form saved.
 */
function hasCoordinates(
  pvConfig: { latitude?: number | null; longitude?: number | null } | undefined,
): boolean {
  const { latitude, longitude } = pvConfig ?? {};
  if (latitude == null || longitude == null || Number.isNaN(latitude) || Number.isNaN(longitude)) return false;
  return latitude !== 0 || longitude !== 0;
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

  // validationWindow is always set by loadPredictionConfig()
  const windowStart = new Date(validationWindow!.start).getTime();
  const windowEnd = new Date(validationWindow!.end).getTime();

  const results: ValidationEntry[] = [];
  for (const cfg of allConfigs) {
    // Predict only the scored window — predicting the full history and
    // filtering afterwards did ~9x the work for the same metrics.
    const targets = data.filter(
      d => d.sensor === cfg.sensor && d.time >= windowStart && d.time < windowEnd
    );
    const validationPredictions = predict(data, cfg, targets);
    const metrics = validate(validationPredictions, validationWindow!);

    results.push({
      type: 'historical',
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

  results.push(...await runTemperatureValidation(config, data, sensorNames, MAX_LOOKBACK_WEEKS));

  return { sensorNames, results };
}

/**
 * Evaluate the temperature-predictor grid against the validation window.
 * Anchors are rebuilt per validated day with the cutoff at that day's start
 * (rolling, like the historical predictor's per-day lookback), so a day never
 * feeds its own anchors and both types are scored on the same information
 * set. Skipped (with a warning) when no coordinates are configured or
 * Open-Meteo is unavailable — historical results still stand.
 */
async function runTemperatureValidation(
  config: PredictionRunConfig,
  data: ReturnType<typeof postprocess>,
  sensorNames: string[],
  maxLookbackWeeks: number,
): Promise<ValidationEntry[]> {
  if (!hasCoordinates(config.pvConfig)) return [];
  const { latitude, longitude } = config.pvConfig!;

  const validationWindow = config.validationWindow!;
  const windowStartMs = new Date(validationWindow.start).getTime();
  const windowEndMs = new Date(validationWindow.end).getTime();

  let effTemps: Map<string, number>;
  try {
    const pastDays = (maxLookbackWeeks + 1) * 7 + 2;
    const temps = await fetchTemperatureSeries(latitude, longitude, pastDays, 2);
    effTemps = computeEffectiveDayTemps(computeDayMeanTemps(temps));
  } catch (err) {
    console.warn('[predict] temperature validation skipped:', err instanceof Error ? err.message : err);
    return [];
  }

  // One raw-record scan per sensor; the config grid then works on the
  // per-day summaries only.
  const summariesBySensor = new Map(
    sensorNames.map(s => [s, summarizeTemperatureDays(data, s, effTemps)]),
  );

  const results: ValidationEntry[] = [];
  for (const cfg of generateTemperatureConfigs(sensorNames)) {
    const targets = data.filter(
      d => d.sensor === cfg.sensor && d.time >= windowStartMs && d.time < windowEndMs
    );
    const predictions = predictTemperatureLoadRolling(summariesBySensor.get(cfg.sensor)!, cfg, targets, effTemps);
    const metrics = validate(predictions, validationWindow);

    results.push({
      type: 'temperature',
      sensor: cfg.sensor,
      lookbackWeeks: cfg.lookbackWeeks,
      dayFilter: cfg.dayFilter,
      bins: cfg.bins,
      mae: metrics.mae,
      rmse: metrics.rmse,
      mape: metrics.mape,
      n: metrics.n,
      nSkipped: metrics.nSkipped,
      validationPredictions: predictions,
    });
  }
  return results;
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
  const temperature = predictors.filter(p => p.type === 'temperature');
  const fixed_W = predictors
    .filter(p => p.type === 'fixed')
    .reduce((sum, p) => sum + p.load_W, 0);

  const nowMs = Date.now();
  const { startIso, endIso } = getForecastTimeRange(nowMs, config.extendedHorizonDays ?? 0);
  const noMetrics = { mae: NaN, rmse: NaN, mape: NaN, n: 0 };

  const sensorPredictors: Array<HistoricalLoadPredictor | TemperatureLoadPredictor> = [...historical, ...temperature];

  if (sensorPredictors.length === 0) {
    const startMs = new Date(startIso).getTime();
    const endMs = new Date(endIso).getTime();
    const nSlots = Math.round((endMs - startMs) / (15 * 60 * 1000));
    const forecast: ForecastSeries = { start: startIso, step: 15, values: Array(nSlots).fill(fixed_W) };
    return { forecast, recent: [], metrics: noMetrics };
  }

  const includeRecent = config.includeRecent !== false;
  const extraWeeks = includeRecent ? 1 : 0;
  const maxLookbackWeeks = Math.max(...sensorPredictors.map(p => p.lookbackWeeks));
  const startTime = new Date(nowMs - (maxLookbackWeeks + extraWeeks) * 7 * 24 * 60 * 60 * 1000).toISOString();

  const recentStart = nowMs - 7 * 24 * 60 * 60 * 1000;
  const futureStart = Math.floor(nowMs / 3600000) * 3600000;
  const futureEnd = new Date(endIso).getTime();

  const [rawData, effTemps] = await Promise.all([
    fetchHaStats({
      haUrl,
      haToken,
      entityIds: sensors.map(s => s.id),
      startTime,
    }),
    fetchEffectiveDayTemps(config, temperature, { nowMs, extraWeeks, futureEnd }),
  ]);

  const data = postprocess(rawData, sensors, derived);

  // Temperature anchors are rebuilt from raw history on every run (stateless,
  // like the PV models).
  const temperatureModels = new Map(
    temperature.map(p => [p, buildTemperatureAnchors(data, effTemps, p, nowMs)]),
  );

  const predictFor = (
    p: HistoricalLoadPredictor | TemperatureLoadPredictor,
    targets: PredictTarget[],
  ) => p.type === 'historical'
    ? predict(data, p, targets)
    : predictTemperatureLoad(temperatureModels.get(p)!, p.dayFilter, targets, effTemps);

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
  const perPredictorFuture = sensorPredictors.map(p => predictFor(p, futureTargets));
  const mappedPoints = futureTargets.map((t, i) => ({
    time: t.time,
    value: fixed_W + perPredictorFuture.reduce((sum, predictions) => sum + (predictions[i].predicted ?? 0), 0),
  }));
  const forecastSeries = buildForecastSeries(mappedPoints, startIso, endIso);

  // Recent accuracy: sum per slot across predictors, only where every predictor
  // has an entry; a null component makes the slot's sum null.
  let recent: PredictionResult[] = [];
  if (includeRecent) {
    // Temperature anchors for the backtest are rebuilt per scored day with
    // the cutoff at that day's start — the same rolling information set the
    // historical predictor uses, and a day never feeds its own anchors.
    const recentMaps = sensorPredictors.map(p => {
      const recentTargets = data.filter(d => d.sensor === p.sensor && d.time >= recentStart && d.time <= nowMs);
      const results = p.type === 'historical'
        ? predict(data, p, recentTargets)
        : predictTemperatureLoadRolling(summarizeTemperatureDays(data, p.sensor, effTemps), p, recentTargets, effTemps);
      return new Map(results.map(r => [r.time, r]));
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

/**
 * Fetch outside temperatures covering the temperature predictors' lookback
 * (plus 2 days for the inertia blend) through the forecast window, reduced
 * to effective per-day temperatures. Empty map when no temperature
 * predictors are configured.
 */
async function fetchEffectiveDayTemps(
  config: PredictionRunConfig,
  temperature: TemperatureLoadPredictor[],
  { nowMs, extraWeeks, futureEnd }: { nowMs: number; extraWeeks: number; futureEnd: number },
): Promise<Map<string, number>> {
  if (temperature.length === 0) return new Map();

  if (!hasCoordinates(config.pvConfig)) {
    throw new Error('temperature predictor requires latitude/longitude in the PV forecast settings');
  }
  const { latitude, longitude } = config.pvConfig!;

  const DAY_MS = 24 * 60 * 60 * 1000;
  const maxLookbackWeeks = Math.max(...temperature.map(p => p.lookbackWeeks));
  const pastDays = (maxLookbackWeeks + extraWeeks) * 7 + 2;
  const todayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const forecastDays = Math.max(2, Math.ceil((futureEnd - todayStart) / DAY_MS));

  const temps = await fetchTemperatureSeries(latitude, longitude, pastDays, forecastDays);
  return computeEffectiveDayTemps(computeDayMeanTemps(temps));
}
