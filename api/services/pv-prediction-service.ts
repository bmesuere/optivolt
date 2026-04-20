/**
 * pv-prediction-service.ts
 *
 * Orchestrates PV forecast pipeline:
 *   HA history + Open-Meteo archive → capacity estimation → Open-Meteo forecast → PV forecast.
 */

import { fetchHaStats } from './ha-client.ts';
import { postprocess, aggregateTo15Min } from '../../lib/ha-postprocess.ts';
import { fetchArchiveIrradiance, fetchForecastIrradiance } from './open-meteo-client.ts';
import { expandHourlyTo15Min } from '../../lib/open-meteo.ts';
import {
  calculateMaxProductionPerHour,
  calculateMaxProductionPerSlot,
  calculateMaxRatioPerHour,
  estimateHourlyCapacity,
  estimateSlotCapacity,
  forecastPv,
  forecastPvSlot,
  slotOfDay,
  validatePvForecast,
} from '../../lib/predict-pv.ts';
import type { PvProductionRecord, PvForecastPoint } from '../../lib/predict-pv.ts';
import type { PredictionRunConfig, PvMode } from '../types.ts';
import { getForecastTimeRange, buildForecastSeries, type ForecastSeries } from '../../lib/time-series-utils.ts';

export interface PvForecastRunResult {
  forecast: ForecastSeries;
  points: PvForecastPoint[];
  recent: PvForecastPoint[];
  metrics: { mae: number; rmse: number; n: number };
}

/**
 * Run the full PV forecast pipeline.
 */
export async function runPvForecast(config: PredictionRunConfig): Promise<PvForecastRunResult> {
  const { haUrl, haToken, sensors, derived, pvConfig } = config;

  if (!pvConfig) {
    throw new Error('pvConfig is required for PV forecasting');
  }

  const { latitude, longitude, historyDays, pvSensor } = pvConfig;

  // Resolve pvMode — prefer the new field, fall back to deprecated forecastResolution.
  // @deprecated fallback: forecastResolution === 15 → 'hybrid', else 'hourly'
  const pvMode: PvMode = pvConfig.pvMode
    ?? (pvConfig.forecastResolution === 15 ? 'hybrid' : 'hourly');

  const is15MinMode = pvMode === '15min';
  const forecastResolution = pvMode === 'hourly' ? 60 : 15;

  if (latitude == null || Number.isNaN(latitude) || longitude == null || Number.isNaN(longitude)) {
    throw new Error('Latitude and longitude must be configured for PV forecasting');
  }

  const entityIds = sensors.map(s => s.id);

  // 1. Compute date range (before fetching, so all I/O can be parallelized)
  const endTime = new Date();
  // HA 5-min statistics have ~10 day retention; clamp for 15min mode.
  const effectiveHistoryDays = is15MinMode ? Math.min(historyDays, 10) : historyDays;
  const startTime = new Date(endTime.getTime() - effectiveHistoryDays * 24 * 60 * 60 * 1000);
  const startDate = startTime.toISOString().slice(0, 10);
  const endDate = endTime.toISOString().slice(0, 10);

  // 2. Fetch HA history, archive irradiance, and forecast irradiance in parallel
  const [rawData, archiveIrradiance, forecastIrradiance] = await Promise.all([
    fetchHaStats({
      haUrl,
      haToken,
      entityIds,
      startTime: startTime.toISOString(),
      period: is15MinMode ? '5minute' : 'hour',
    }),
    fetchArchiveIrradiance(latitude, longitude, startDate, endDate),
    fetchForecastIrradiance(latitude, longitude, undefined, forecastResolution),
  ]);

  let data = postprocess(rawData, sensors, derived);
  if (is15MinMode) {
    data = aggregateTo15Min(data);
  }

  // The LP expects pv_W (watts = Wh/hour average). Hourly HA data directly gives
  // Wh/hour. 15-min HA data gives Wh/15min, so we scale ×4 to get Wh/hour = W.
  const productionScale = is15MinMode ? 4 : 1;

  // Filter to the PV sensor and convert to PvProductionRecord[]
  const pvRecords: PvProductionRecord[] = data
    .filter(d => d.sensor === pvSensor && d.value > 0)
    .map(d => ({
      time: d.time,
      hour: d.hour,
      ...(is15MinMode ? { slot: slotOfDay(d.time) } : {}),
      production_Wh: d.value * productionScale,
    }));

  // Build actual production map for validation (timestamp → scaled Wh)
  // Scale matches pvRecords so error metrics are in consistent units.
  const actualsMap = new Map<number, number>();
  for (const d of data) {
    if (d.sensor === pvSensor) {
      actualsMap.set(d.time, d.value * productionScale);
    }
  }

  const maxRatio = calculateMaxRatioPerHour(archiveIrradiance, latitude, longitude);

  // 4. Generate forecast and validation points, branching on mode
  let futurePoints: PvForecastPoint[];
  let archivePoints: PvForecastPoint[];

  if (is15MinMode) {
    const maxProd96 = calculateMaxProductionPerSlot(pvRecords);
    const slotCapacity = estimateSlotCapacity(maxProd96, maxRatio);

    futurePoints = forecastPvSlot(slotCapacity, forecastIrradiance, latitude, longitude, actualsMap);

    // Expand hourly archive to 15-min for slot-level validation
    const archiveIrradiance15 = expandHourlyTo15Min(archiveIrradiance);
    archivePoints = forecastPvSlot(slotCapacity, archiveIrradiance15, latitude, longitude, actualsMap);
  } else {
    const maxProd = calculateMaxProductionPerHour(pvRecords);
    const capacity = estimateHourlyCapacity(maxProd, maxRatio);

    futurePoints = forecastPv(capacity, forecastIrradiance, latitude, longitude, actualsMap);
    archivePoints = forecastPv(capacity, archiveIrradiance, latitude, longitude, actualsMap);
  }

  // 6. Build 15-min series for the solver (from future points only)
  const now = new Date();
  const { startIso, endIso } = getForecastTimeRange(now.getTime());

  const mappedFuturePoints = futurePoints.map(p => ({
    time: p.time,
    value: p.predicted ?? 0
  }));
  const forecast = buildForecastSeries(mappedFuturePoints, startIso, endIso, forecastResolution);

  // 7. Split: future points for forecast chart, archive points for validation chart
  const nowMs = now.getTime();
  const points = futurePoints.filter(p => p.time >= nowMs - 3600000);
  const recentCutoff = nowMs - 7 * 24 * 60 * 60 * 1000;
  // Scale recent points back to Wh/interval (undoing the productionScale applied for the LP solver).
  // In 15min mode productionScale=4 so values are Wh/hour; dividing by 4 gives Wh/15min so that
  // summing all 96 intervals per day yields correct daily Wh totals in the accuracy charts.
  const recent = archivePoints
    .filter(p => p.time >= recentCutoff && p.time < nowMs && p.actual !== null)
    .map(p => ({
      ...p,
      predicted: p.predicted !== null ? p.predicted / productionScale : null,
      actual: p.actual !== null ? p.actual / productionScale : null,
    }));

  // 8. Validation metrics
  const metrics = validatePvForecast(recent);

  return { forecast, points, recent, metrics };
}
