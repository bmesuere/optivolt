/**
 * pv-forecast.ts
 *
 * Assembles PV forecast points from forecast irradiance and a per-bucket
 * model (hourly capacity, 15-min slot capacity, or a linear direct/diffuse
 * model), plus validation of those points against actuals.
 *
 * All three variants share one loop and differ only in the bucket index,
 * the mid-interval offset at which the clear-sky baseline is evaluated,
 * and how a bucket is turned into a prediction.
 */

import { calculateClearSkyGHI } from './pv-clear-sky.ts';
import {
  getRadiationFeatures,
  slotOfDay,
  type HourlyCapacity,
  type IrradianceRecord,
  type SlotCapacity,
} from './pv-capacity.ts';
import type { PvLinearModel } from './pv-linear-fit.ts';
import { computeErrorMetrics, type PredictionResult, type ValidationMetrics } from './time-series-utils.ts';

export interface PvForecastPoint extends PredictionResult {
  ghiClear_W_per_m2: number;     // Bird model clear-sky baseline
  ghiForecast_W_per_m2: number;  // Open-Meteo forecast/archive value
  directRadiation_W_per_m2?: number;
  diffuseRadiation_W_per_m2?: number;
  forecastRatio: number;         // ghiForecast / ghiClear
}

interface ForecastRadiation {
  direct?: number;
  diffuse?: number;
}

interface ForecastPointContext {
  rec: IrradianceRecord;
  bucket: number;
  ghiClear_W_per_m2: number;
  forecastRatio: number;
  radiation: ForecastRadiation;
}

interface PvForecastSpec {
  /** Index into the per-bucket model array (hour 0-23 or slot 0-95). */
  bucketIndex(rec: IrradianceRecord): number;
  /** Timestamp (ms) at which the Bird clear-sky baseline is evaluated. */
  midIntervalMs(rec: IrradianceRecord): number;
  /** Optional clear-sky baseline reused from elsewhere; falls back to the Bird model. */
  ghiClear?(rec: IrradianceRecord): number | undefined;
  /** Radiation reported on the point; defaults to the raw record fields. */
  radiation?(rec: IrradianceRecord): ForecastRadiation;
  /** Predicted production (Wh), clamped to >= 0 by the caller. */
  predict(ctx: ForecastPointContext): number;
}

/** Shared forecast loop: one point per irradiance record. */
function buildForecastPoints(
  forecastIrradiance: IrradianceRecord[],
  lat: number,
  lon: number,
  actuals: Map<number, number> | undefined,
  spec: PvForecastSpec,
): PvForecastPoint[] {
  const points: PvForecastPoint[] = [];

  for (const rec of forecastIrradiance) {
    const bucket = spec.bucketIndex(rec);
    const radiation = spec.radiation
      ? spec.radiation(rec)
      : { direct: rec.directRadiation_W_per_m2, diffuse: rec.diffuseRadiation_W_per_m2 };

    const ghiClear = spec.ghiClear?.(rec)
      ?? calculateClearSkyGHI(lat, lon, new Date(spec.midIntervalMs(rec)));
    const forecastRatio = ghiClear > 5 ? rec.ghi_W_per_m2 / ghiClear : 0;

    const predicted = spec.predict({
      rec,
      bucket,
      ghiClear_W_per_m2: ghiClear,
      forecastRatio,
      radiation,
    });

    points.push({
      time: rec.time,
      hour: rec.hour,
      ghiClear_W_per_m2: ghiClear,
      ghiForecast_W_per_m2: rec.ghi_W_per_m2,
      directRadiation_W_per_m2: radiation.direct,
      diffuseRadiation_W_per_m2: radiation.diffuse,
      forecastRatio,
      predicted: Math.max(0, predicted),
      actual: actuals?.get(rec.time) ?? null,
    });
  }

  return points;
}

/**
 * Generate PV forecast points from hourly capacity and forecast irradiance.
 *
 * For each forecast irradiance record:
 *   1. Compute Bird clear-sky GHI at mid-interval.
 *   2. forecastRatio = ghiForecast / ghiClear (0 if ghiClear < 5).
 *   3. prediction = forecastRatio × trueCapacity[hour].
 *   4. Look up actual production if available.
 *
 * @param capacity     Per-hour capacity estimates (length 24)
 * @param forecastIrradiance  Irradiance records (already interval-start aligned)
 * @param lat          Latitude
 * @param lon          Longitude
 * @param actuals      Optional map: timestamp_ms → production_Wh
 */
export function forecastPv(
  capacity: HourlyCapacity[],
  forecastIrradiance: IrradianceRecord[],
  lat: number,
  lon: number,
  actuals?: Map<number, number>,
): PvForecastPoint[] {
  return buildForecastPoints(forecastIrradiance, lat, lon, actuals, {
    bucketIndex: rec => rec.hour,
    // To match the hourly capacity estimation baseline, we evaluate the
    // Bird clear-sky GHI at the mid-point of the hour (HH:30) for ALL slots.
    midIntervalMs: rec => Math.floor(rec.time / 3600000) * 3600000 + 30 * 60 * 1000,
    predict: ({ bucket, forecastRatio }) => forecastRatio * (capacity[bucket]?.trueCapacity_Wh ?? 0),
  });
}

/**
 * Generate PV forecast points using the 96-slot capacity model.
 *
 * Like forecastPv() but:
 *  - Capacity is looked up by slot (0-95) via slotOfDay(rec.time).
 *  - Bird clear-sky GHI is evaluated at the 15-min mid-interval
 *    (slot_start + 7.5 min) for more accurate sub-hour predictions.
 *
 * @param capacity     Per-slot capacity estimates (length 96)
 * @param forecastIrradiance  Irradiance records (already interval-start aligned)
 * @param lat          Latitude
 * @param lon          Longitude
 * @param actuals      Optional map: timestamp_ms → production_Wh
 */
export function forecastPvSlot(
  capacity: SlotCapacity[],
  forecastIrradiance: IrradianceRecord[],
  lat: number,
  lon: number,
  actuals?: Map<number, number>,
): PvForecastPoint[] {
  return buildForecastPoints(forecastIrradiance, lat, lon, actuals, {
    bucketIndex: rec => slotOfDay(rec.time),
    midIntervalMs: rec => Math.floor(rec.time / 900000) * 900000 + 7.5 * 60 * 1000,
    predict: ({ bucket, forecastRatio }) => forecastRatio * (capacity[bucket]?.trueCapacity_Wh ?? 0),
  });
}

/**
 * Generate PV forecast points from robust per-hour or per-slot direct+diffuse
 * radiation models. Missing or unstable model buckets fall back to the supplied
 * clear-sky forecast point for the same timestamp.
 */
export function forecastPvLinear(
  models: PvLinearModel[],
  forecastIrradiance: IrradianceRecord[],
  lat: number,
  lon: number,
  actuals?: Map<number, number>,
  fallbackPoints?: Map<number, PvForecastPoint>,
): PvForecastPoint[] {
  const useSlots = models.length === 96;

  return buildForecastPoints(forecastIrradiance, lat, lon, actuals, {
    bucketIndex: rec => useSlots ? slotOfDay(rec.time) : rec.hour,
    midIntervalMs: rec => rec.time + (rec.intervalMinutes / 2) * 60 * 1000,
    ghiClear: rec => fallbackPoints?.get(rec.time)?.ghiClear_W_per_m2,
    radiation: rec => getRadiationFeatures(rec) ?? {},
    predict: ({ rec, bucket, radiation }) => {
      const model = models[bucket];
      if (radiation.direct != null && radiation.diffuse != null && model && !model.fallback) {
        return model.directCoeff * radiation.direct + model.diffuseCoeff * radiation.diffuse;
      }
      return fallbackPoints?.get(rec.time)?.predicted ?? 0;
    },
  });
}

/**
 * Compute validation metrics from forecast points that have actuals.
 */
export function validatePvForecast(points: PvForecastPoint[]): ValidationMetrics {
  const withActuals = points.filter(p => p.actual !== null);

  const metrics = computeErrorMetrics(
    withActuals,
    p => p.actual!,
    p => p.predicted
  );

  return {
    mae: metrics.mae,
    rmse: metrics.rmse,
    mape: metrics.mape,
    n: metrics.n,
  };
}
