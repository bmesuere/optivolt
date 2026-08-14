/**
 * Utility functions for handling time series data.
 */

import type { TimeSeries } from './types.ts';

export interface ForecastSeries {
  start: string;
  step: number;
  values: number[];
}

export interface ValidationMetrics {
  mae: number;
  rmse: number;
  mape: number;
  n: number;
}

export interface PredictionResult {
  date?: string;
  time: number;
  hour: number;
  actual: number | null;
  predicted: number | null;
}

/**
 * Rounds a date down to the nearest step (default 15 minutes).
 */
export function getQuarterStart(date: Date | number | string = new Date(), stepMinutes = 15): number {
  const d = new Date(date);
  const stepMs = stepMinutes * 60 * 1000;
  if (!Number.isFinite(stepMs) || stepMs <= 0) return NaN;
  return Math.floor(d.getTime() / stepMs) * stepMs;
}

/**
 * Resamples a source time series into a target window using overlap-weighted averages.
 * Missing portions of target slots are padded with 0.
 */
export function extractWindow(
  source: TimeSeries,
  targetStartMs: number,
  targetEndMs: number,
  targetStepMinutes = source.step || 15,
): number[] {
  const sourceStartMs = new Date(source.start).getTime();
  const sourceStepMs = (source.step || 15) * 60 * 1000;
  const targetStepMs = targetStepMinutes * 60 * 1000;
  const targetSlots = Math.floor((targetEndMs - targetStartMs) / targetStepMs);

  const result: number[] = [];

  for (let i = 0; i < targetSlots; i++) {
    const slotStartMs = targetStartMs + i * targetStepMs;
    const slotEndMs = slotStartMs + targetStepMs;
    let sourceIndex = Math.max(0, Math.floor((slotStartMs - sourceStartMs) / sourceStepMs));
    let weightedValue = 0;

    while (sourceIndex < source.values.length) {
      const sourceSlotStartMs = sourceStartMs + sourceIndex * sourceStepMs;
      const sourceSlotEndMs = sourceSlotStartMs + sourceStepMs;
      if (sourceSlotStartMs >= slotEndMs) break;

      const overlapMs = Math.max(
        0,
        Math.min(slotEndMs, sourceSlotEndMs) - Math.max(slotStartMs, sourceSlotStartMs),
      );
      if (overlapMs > 0) {
        weightedValue += source.values[sourceIndex] * (overlapMs / targetStepMs);
      }
      sourceIndex += 1;
    }

    // Uncovered parts of a target slot retain the historical zero-padding behavior.
    result.push(weightedValue);
  }

  return result;
}

/**
 * Calculates the standard forecast time window.
 * Forecast duration:
 * < 13:00 -> until midnight tonight
 * >= 13:00 -> until midnight tomorrow
 *
 * @param nowMs The current time in milliseconds (defaults to Date.now())
 * @param extraDays Additional whole days beyond the standard window (extended horizon)
 * @returns An object containing the startIso (aligned to 15m) and endIso (midnight)
 */
export function getForecastTimeRange(nowMs = Date.now(), extraDays = 0): { startIso: string; endIso: string } {
  const now = new Date(nowMs);
  const currentHour = now.getHours();

  const end = new Date(now);
  end.setMinutes(0, 0, 0);
  if (currentHour < 13) {
    end.setDate(end.getDate() + 1 + extraDays);
    end.setHours(0, 0, 0, 0);
  } else {
    end.setDate(end.getDate() + 2 + extraDays);
    end.setHours(0, 0, 0, 0);
  }

  const startMs = Math.floor(now.getTime() / (15 * 60 * 1000)) * (15 * 60 * 1000);
  const startIso = new Date(startMs).toISOString();
  const endIso = end.toISOString();

  return { startIso, endIso };
}

/**
 * Build a 15-min forecast series for a specific time range.
 * Missing slots → 0.
 *
 * @param points Array of timestamp/value pairs.
 * @param startIso ISO string for the start of the 15-min series.
 * @param endIso ISO string for the end of the 15-min series.
 * @param inputStep Minutes per input point: 60 (hourly, default) or 15.
 *   - 60: each hourly value is repeated for all four 15-min slots in that hour.
 *   - 15: each 15-min point maps directly to its slot.
 */
export function buildForecastSeries(
  points: { time: number; value: number }[],
  startIso: string,
  endIso: string,
  inputStep: number = 60,
): ForecastSeries {
  const startTs = new Date(startIso).getTime();
  const endTs = new Date(endIso).getTime();
  const stepMs = 15 * 60 * 1000;

  const predMap = new Map<number, number>();
  if (inputStep === 15) {
    // Map by 15-min bucket
    for (const p of points) {
      if (p.value !== null && p.value !== undefined) {
        const bucket = Math.floor(p.time / 900000) * 900000;
        predMap.set(bucket, p.value);
      }
    }
  } else {
    // Map by hour start (each hourly value covers all four 15-min slots)
    for (const p of points) {
      if (p.value !== null && p.value !== undefined) {
        const h = Math.floor(p.time / 3600000) * 3600000;
        predMap.set(h, p.value);
      }
    }
  }

  const values: number[] = [];
  if (inputStep === 15) {
    for (let t = startTs; t < endTs; t += stepMs) {
      values.push(predMap.get(t) ?? 0);
    }
  } else {
    for (let t = startTs; t < endTs; t += stepMs) {
      values.push(predMap.get(Math.floor(t / 3600000) * 3600000) ?? 0);
    }
  }

  return { start: startIso, step: 15, values };
}

/**
 * Extend an actual time series with the tail of a forecast series.
 *
 * Actual values always win: the forecast contributes only slots strictly after
 * the end of the actual series. Returns the actual series unchanged when the
 * forecast is missing, does not reach past the actual data, or starts after
 * the actual series ends (a gap would otherwise be zero-filled).
 */
export function extendSeriesWithForecast(actual: TimeSeries, forecast?: TimeSeries): TimeSeries {
  if (!forecast || !Array.isArray(forecast.values) || forecast.values.length === 0) return actual;

  const step = actual.step ?? 15;
  const stepMs = step * 60_000;
  const actualEndMs = new Date(actual.start).getTime() + actual.values.length * stepMs;
  const forecastStartMs = new Date(forecast.start).getTime();
  const forecastEndMs = forecastStartMs + forecast.values.length * (forecast.step ?? 15) * 60_000;

  if (!Number.isFinite(actualEndMs) || !Number.isFinite(forecastStartMs) || !Number.isFinite(forecastEndMs)) return actual;
  if (forecastEndMs <= actualEndMs) return actual;
  if (forecastStartMs > actualEndMs) return actual; // gap between actual and forecast

  const tailSlots = Math.floor((forecastEndMs - actualEndMs) / stepMs);
  if (tailSlots <= 0) return actual;

  const tail = extractWindow(forecast, actualEndMs, actualEndMs + tailSlots * stepMs, step);
  return {
    start: actual.start,
    step,
    values: [...actual.values, ...tail],
  };
}

// ---------------------------------------------------------------------------
// Error Metrics
// ---------------------------------------------------------------------------

/**
 * Compute Mean Absolute Error (MAE) and Root Mean Square Error (RMSE).
 * If there are no valid pairs, MAE and RMSE return 0, and MAPE returns NaN.
 *
 * @param pairs Array of objects containing actual and predicted values.
 * @param getActual Function to extract the actual value from a pair.
 * @param getPredicted Function to extract the predicted value from a pair.
 */
export function computeErrorMetrics<T>(
  pairs: T[],
  getActual: (d: T) => number | null | undefined,
  getPredicted: (d: T) => number | null | undefined
): { mae: number; rmse: number; mape: number; n: number } {
  let sumAbs = 0;
  let sumSq = 0;
  let sumAPE = 0;
  let mapeCount = 0;
  let n = 0;

  for (const pair of pairs) {
    const actual = getActual(pair);
    const predicted = getPredicted(pair);
    if (actual != null && predicted != null) {
      const err = actual - predicted;
      sumAbs += Math.abs(err);
      sumSq += err * err;
      n++;

      if (Math.abs(actual) > 5) {
        sumAPE += Math.abs(err / actual);
        mapeCount++;
      }
    }
  }

  if (n === 0) return { mae: 0, rmse: 0, mape: NaN, n: 0 };
  return {
    mae: sumAbs / n,
    rmse: Math.sqrt(sumSq / n),
    mape: mapeCount > 0 ? (sumAPE / mapeCount) * 100 : NaN,
    n
  };
}
