/**
 * pv-prediction-service.ts
 *
 * Orchestrates PV forecast pipeline:
 *   HA history + Open-Meteo archive → capacity estimation → Open-Meteo forecast → PV forecast.
 */

import { fetchHaStats } from './ha-client.ts';
import { postprocess } from '../../lib/ha-postprocess.ts';
import { fetchArchiveIrradiance, fetchForecastIrradiance } from './open-meteo-client.ts';
import {
  calculateMaxProductionPerHour,
  calculateMaxRatioPerHour,
  estimateHourlyCapacity,
  forecastPv,
  buildPvForecastSeries,
  validatePvForecast,
} from '../../lib/predict-pv.ts';
import type { PvProductionRecord, PvForecastPoint } from '../../lib/predict-pv.ts';
import type { ForecastSeries } from '../../lib/predict-load.ts';
import type { PredictionConfig } from '../types.ts';

export interface PvForecastRunResult {
  forecast: ForecastSeries;
  points: PvForecastPoint[];
  recent: PvForecastPoint[];
  metrics: { mae: number; rmse: number; n: number };
}

/**
 * Run the full PV forecast pipeline.
 */
export async function runPvForecast(config: PredictionConfig): Promise<PvForecastRunResult> {
  const { haUrl, haToken, sensors, derived, pvConfig } = config;

  if (!pvConfig) {
    throw new Error('pvConfig is required for PV forecasting');
  }

  const { latitude, longitude, historyDays, pvSensor } = pvConfig;

  if (!latitude || !longitude) {
    throw new Error('Latitude and longitude must be configured for PV forecasting');
  }

  const entityIds = sensors.map(s => s.id);

  // 1. Fetch historic PV production from HA
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - historyDays * 24 * 60 * 60 * 1000);
  const startTimeStr = startTime.toISOString();

  const rawData = await fetchHaStats({
    haUrl,
    haToken,
    entityIds,
    startTime: startTimeStr,
  });

  const data = postprocess(rawData, sensors, derived);

  // Filter to the PV sensor and convert to PvProductionRecord[]
  const pvRecords: PvProductionRecord[] = data
    .filter(d => d.sensor === pvSensor && d.value > 0)
    .map(d => ({
      time: d.time,
      hour: d.hour,
      production_Wh: d.value,
    }));

  // Build actual production map for validation (timestamp → Wh)
  const actualsMap = new Map<number, number>();
  for (const d of data) {
    if (d.sensor === pvSensor) {
      actualsMap.set(d.time, d.value);
    }
  }

  // 2. Fetch historic irradiance from Open-Meteo Archive
  const startDate = startTime.toISOString().slice(0, 10);
  const endDate = endTime.toISOString().slice(0, 10);
  const archiveIrradiance = await fetchArchiveIrradiance(latitude, longitude, startDate, endDate);

  // 3. Capacity estimation
  const maxProd = calculateMaxProductionPerHour(pvRecords);
  const maxRatio = calculateMaxRatioPerHour(archiveIrradiance, latitude, longitude);
  const capacity = estimateHourlyCapacity(maxProd, maxRatio);

  // 4. Fetch forecast irradiance from Open-Meteo
  const forecastIrradiance = await fetchForecastIrradiance(latitude, longitude);

  // 5. Generate forecast points for future (from forecast API)
  const futurePoints = forecastPv(capacity, forecastIrradiance, latitude, longitude, actualsMap);

  // 6. Generate historical comparison points from archive irradiance
  //    This gives us predicted-vs-actual for the full history period, not just
  //    the ~2 days covered by the forecast API's past_days parameter.
  const archivePoints = forecastPv(capacity, archiveIrradiance, latitude, longitude, actualsMap);

  // 7. Build 15-min series for the solver (from future points only)
  const now = new Date();
  const currentHour = now.getHours();

  const seriesEnd = new Date(now);
  seriesEnd.setMinutes(0, 0, 0);
  if (currentHour < 13) {
    seriesEnd.setDate(seriesEnd.getDate() + 1);
    seriesEnd.setHours(0, 0, 0, 0);
  } else {
    seriesEnd.setDate(seriesEnd.getDate() + 2);
    seriesEnd.setHours(0, 0, 0, 0);
  }

  const startMs = Math.floor(now.getTime() / (15 * 60 * 1000)) * (15 * 60 * 1000);
  const startIso = new Date(startMs).toISOString();
  const endIso = seriesEnd.toISOString();

  const forecast = buildPvForecastSeries(futurePoints, startIso, endIso);

  // 8. Split: future points for forecast chart, archive points for validation chart
  const nowMs = now.getTime();
  const points = futurePoints.filter(p => p.time >= nowMs - 3600000);
  const recentCutoff = nowMs - 7 * 24 * 60 * 60 * 1000;
  const recent = archivePoints.filter(p => p.time >= recentCutoff && p.time < nowMs && p.actual_Wh !== null);

  // 9. Validation metrics
  const metrics = validatePvForecast(recent);

  return { forecast, points, recent, metrics };
}
