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
  const q = Math.floor(d.getMinutes() / stepMinutes) * stepMinutes;
  d.setMinutes(q, 0, 0);
  return d.getTime();
}

/**
 * Extracts a window of data from a source time series to match a target start time.
 * Missing slots are padded with 0.
 */
export function extractWindow(source: TimeSeries, targetStartMs: number, targetEndMs: number): number[] {
  const sourceStartMs = new Date(source.start).getTime();
  const stepMs = (source.step || 15) * 60 * 1000;

  // Calculate offset in slots
  // If source starts BEFORE target, offset is positive (we skip some source data)
  // If source starts AFTER target, offset is negative (we need padding)
  const offsetMs = targetStartMs - sourceStartMs;
  const offsetSlots = Math.floor(offsetMs / stepMs);

  const targetDurationMs = targetEndMs - targetStartMs;
  const targetSlots = Math.floor(targetDurationMs / stepMs);

  const result: number[] = [];

  for (let i = 0; i < targetSlots; i++) {
    const sourceIndex = offsetSlots + i;

    if (sourceIndex >= 0 && sourceIndex < source.values.length) {
      result.push(source.values[sourceIndex]);
    } else {
      // Pad with 0 for missing data
      result.push(0);
    }
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
 * @returns An object containing the startIso (aligned to 15m) and endIso (midnight)
 */
export function getForecastTimeRange(nowMs = Date.now()): { startIso: string; endIso: string } {
  const now = new Date(nowMs);
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

  const startMs = Math.floor(now.getTime() / (15 * 60 * 1000)) * (15 * 60 * 1000);
  const startIso = new Date(startMs).toISOString();
  const endIso = end.toISOString();

  return { startIso, endIso };
}

/**
 * Build a 15-min forecast series for a specific time range.
 * Data is hourly → each 15-min slot gets the same hourly value.
 * Missing hours → 0.
 *
 * @param points Array of timestamp/value pairs (timestamp is start of hour).
 * @param startIso ISO string for the start of the 15-min series.
 * @param endIso ISO string for the end of the 15-min series.
 */
export function buildForecastSeries(
  points: { time: number; value: number }[],
  startIso: string,
  endIso: string,
): ForecastSeries {
  const startTs = new Date(startIso).getTime();
  const endTs = new Date(endIso).getTime();
  const stepMs = 15 * 60 * 1000;

  // Map predictions by time (hour start)
  const predMap = new Map<number, number>();
  for (const p of points) {
    if (p.value !== null && p.value !== undefined) {
      // Ensure key is aligned to start of hour
      const h = Math.floor(p.time / 3600000) * 3600000;
      predMap.set(h, p.value);
    }
  }

  const values: number[] = [];
  for (let t = startTs; t < endTs; t += stepMs) {
    // Hourly bucket
    const hourStart = Math.floor(t / 3600000) * 3600000;
    const val = predMap.get(hourStart) ?? 0;
    values.push(val);
  }

  return { start: startIso, step: 15, values };
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
