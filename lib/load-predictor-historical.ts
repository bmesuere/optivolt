/**
 * load-predictor-historical.ts
 *
 * Pure prediction/validation/forecast logic for load prediction.
 */

import type { StatRecord } from './ha-postprocess.ts';
import { type ForecastSeries, computeErrorMetrics, type PredictionResult, type ValidationMetrics } from './time-series-utils.ts';

export type DayFilter = 'same' | 'all' | 'weekday-weekend' | 'weekday-sat-sun';
export type Aggregation = 'mean' | 'median';

export interface PredictConfig {
  sensor: string;
  lookbackWeeks: number;
  dayFilter: DayFilter;
  aggregation: Aggregation;
}

export interface LoadValidationMetrics extends ValidationMetrics {
  nSkipped: number;
}



/**
 * Map a day-of-week (0=Sun … 6=Sat) to a bucket string based on the filter strategy.
 */
export function getDayBucket(dayOfWeek: number, dayFilter: DayFilter): string | number {
  switch (dayFilter) {
    case 'same':
      return dayOfWeek;
    case 'weekday-weekend':
      return (dayOfWeek >= 1 && dayOfWeek <= 5) ? 'weekday' : 'weekend';
    case 'weekday-sat-sun':
      if (dayOfWeek >= 1 && dayOfWeek <= 5) return 'weekday';
      return dayOfWeek === 6 ? 'saturday' : 'sunday';
    case 'all':
    default:
      return 'all';
  }
}

/** @param values */
export function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** @param values */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Compute predictions for specific target points using history data.
 */
export function predict(
  data: StatRecord[],
  { sensor, lookbackWeeks, dayFilter, aggregation }: PredictConfig,
  targets: Array<Pick<StatRecord, 'date' | 'time' | 'hour' | 'dayOfWeek'> & { value?: number | null }> | null = null,
): PredictionResult[] {
  const sensorHistory = data.filter(d => d.sensor === sensor);
  const valueByDate = new Map(sensorHistory.map(d => [d.date, d]));
  const aggregate = aggregation === 'median' ? median : mean;

  // Predict for explicit targets if provided, otherwise for all history entries
  const entriesToPredict = targets ?? sensorHistory;
  const results: PredictionResult[] = [];

  for (const entry of entriesToPredict) {
    const entryDate = new Date(entry.date);
    const entryBucket = getDayBucket(entry.dayOfWeek, dayFilter);

    const historicalValues: number[] = [];
    const maxDays = lookbackWeeks * 7;

    for (let d = 1; d <= maxDays; d++) {
      // setDate() subtracts in local time, preserving the same wall-clock hour across DST boundaries
      const pastDate = new Date(entryDate);
      pastDate.setDate(pastDate.getDate() - d);
      const pastISO = pastDate.toISOString();
      const pastEntry = valueByDate.get(pastISO);

      if (!pastEntry) continue;

      if (dayFilter === 'same') {
        if (pastEntry.dayOfWeek !== entry.dayOfWeek) continue;
      } else {
        const pastBucket = getDayBucket(pastEntry.dayOfWeek, dayFilter);
        if (entryBucket !== pastBucket) continue;
      }

      historicalValues.push(pastEntry.value);
    }

    results.push({
      date: entry.date,
      time: entry.time,
      hour: entry.hour,
      actual: entry.value ?? null,
      predicted: historicalValues.length > 0 ? aggregate(historicalValues) : null,
    });
  }

  return results;
}

/**
 * Compute error metrics for predictions within the given validation window.
 */
export function validate(
  predictions: PredictionResult[],
  validationWindow: { start: string; end: string },
): LoadValidationMetrics {
  const windowStart = new Date(validationWindow.start).getTime();
  const windowEnd = new Date(validationWindow.end).getTime();

  const inWindow = predictions.filter(p => p.time >= windowStart && p.time < windowEnd);
  const valid = inWindow.filter(p => p.predicted !== null) as Array<PredictionResult & { actual: number; predicted: number }>;
  const n = valid.length;
  let nSkipped = inWindow.length - n;

  if (n === 0) return { mae: NaN, rmse: NaN, mape: NaN, n: 0, nSkipped };

  const baseMetrics = computeErrorMetrics(
    valid,
    p => p.actual,
    p => p.predicted
  );

  return {
    mae: baseMetrics.mae,
    rmse: baseMetrics.rmse,
    mape: baseMetrics.mape,
    n: baseMetrics.n,
    nSkipped,
  };
}

/**
 * Generate all combinations of prediction configurations.
 */
export function generateAllConfigs(
  sensorNames: string[],
  lookbacks: number[] = [1, 2, 3, 4, 6, 8],
  dayFilters: DayFilter[] = ['same', 'all', 'weekday-weekend', 'weekday-sat-sun'],
  aggregations: Aggregation[] = ['mean', 'median'],
): PredictConfig[] {
  const configs: PredictConfig[] = [];
  for (const sensor of sensorNames) {
    for (const lookbackWeeks of lookbacks) {
      for (const dayFilter of dayFilters) {
        for (const aggregation of aggregations) {
          configs.push({ sensor, lookbackWeeks, dayFilter, aggregation });
        }
      }
    }
  }
  return configs;
}
