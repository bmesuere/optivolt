/**
 * predict-load.js
 *
 * Pure prediction/validation/forecast logic for load prediction.
 */

/**
 * Map a day-of-week (0=Sun … 6=Sat) to a bucket string based on the filter strategy.
 * @param {number} dayOfWeek
 * @param {'same'|'all'|'weekday-weekend'|'weekday-sat-sun'} dayFilter
 * @returns {string|number}
 */
export function getDayBucket(dayOfWeek, dayFilter) {
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

/** @param {number[]} values */
export function mean(values) {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** @param {number[]} values */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Compute predictions for specific target points using history data.
 *
 * @param {Array<{date: string, time: number, hour: number, dayOfWeek: number, sensor: string, value: number}>} data  History data
 * @param {{ sensor: string, lookbackWeeks: number, dayFilter: string, aggregation: 'mean'|'median' }} config
 * @param {Array<{date: string, time: number, hour: number, dayOfWeek: number, value: number|null}>|null} targets  Points to predict. If null, predicts for all history entries.
 * @returns {Array<{date: string, time: number, hour: number, actual: number|null, predicted: number|null}>}
 */
export function predict(data, { sensor, lookbackWeeks, dayFilter, aggregation }, targets = null) {
  const sensorHistory = data.filter(d => d.sensor === sensor);
  const valueByDate = new Map(sensorHistory.map(d => [d.date, d]));
  const aggregate = aggregation === 'median' ? median : mean;

  // Predict for explicit targets if provided, otherwise for all history entries
  const entriesToPredict = Array.isArray(targets) ? targets : sensorHistory;
  const results = [];

  for (const entry of entriesToPredict) {
    const entryDate = new Date(entry.date);
    const entryBucket = getDayBucket(entry.dayOfWeek, dayFilter);

    const historicalValues = [];
    const maxDays = lookbackWeeks * 7;

    for (let d = 1; d <= maxDays; d++) {
      const pastDate = new Date(entryDate.getTime() - d * 24 * 60 * 60 * 1000);
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
 *
 * @param {Array<{time: number, actual: number, predicted: number|null}>} predictions
 * @param {{ start: string, end: string }} validationWindow  ISO date strings
 * @returns {{ mae: number, rmse: number, mape: number, n: number, nSkipped: number }}
 */
export function validate(predictions, validationWindow) {
  const windowStart = new Date(validationWindow.start).getTime();
  const windowEnd = new Date(validationWindow.end).getTime();

  const inWindow = predictions.filter(p => p.time >= windowStart && p.time < windowEnd);
  const valid = inWindow.filter(p => p.predicted !== null);
  const n = valid.length;
  const nSkipped = inWindow.length - n;

  if (n === 0) return { mae: NaN, rmse: NaN, mape: NaN, n: 0, nSkipped };

  let sumAE = 0;
  let sumSE = 0;
  let sumAPE = 0;
  let mapeCount = 0;

  for (const { actual, predicted } of valid) {
    const error = actual - predicted;
    sumAE += Math.abs(error);
    sumSE += error * error;

    if (Math.abs(actual) > 5) {
      sumAPE += Math.abs(error / actual);
      mapeCount++;
    }
  }

  return {
    mae: sumAE / n,
    rmse: Math.sqrt(sumSE / n),
    mape: mapeCount > 0 ? (sumAPE / mapeCount) * 100 : NaN,
    n,
    nSkipped,
  };
}

/**
 * Generate all combinations of prediction configurations.
 *
 * @param {string[]} sensorNames
 * @param {number[]} [lookbacks]
 * @param {string[]} [dayFilters]
 * @param {string[]} [aggregations]
 * @returns {Array<{sensor: string, lookbackWeeks: number, dayFilter: string, aggregation: string}>}
 */
export function generateAllConfigs(
  sensorNames,
  lookbacks = [1, 2, 3, 4, 6, 8],
  dayFilters = ['same', 'all', 'weekday-weekend', 'weekday-sat-sun'],
  aggregations = ['mean', 'median'],
) {
  const configs = [];
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

/**
 * Build a 15-min forecast series for a specific time range.
 * Data is hourly → each 15-min slot gets the same hourly value.
 * Missing hours → 0.
 *
 * @param {Array<{time: number, predicted: number|null}>} predictions
 * @param {string} startIso
 * @param {string} endIso
 * @returns {{ start: string, step: number, values: number[] }}
 */
export function buildForecastSeriesRange(predictions, startIso, endIso) {
  const startTs = new Date(startIso).getTime();
  const endTs = new Date(endIso).getTime();
  const stepMs = 15 * 60 * 1000;

  // Map predictions by time (hour start)
  const predMap = new Map();
  for (const p of predictions) {
    if (p.predicted !== null) {
      // Ensure key is aligned to start of hour
      const h = Math.floor(p.time / 3600000) * 3600000;
      predMap.set(h, p.predicted);
    }
  }

  const values = [];
  for (let t = startTs; t < endTs; t += stepMs) {
    // Hourly bucket
    const hourStart = Math.floor(t / 3600000) * 3600000;
    const val = predMap.get(hourStart) ?? 0;
    values.push(val);
  }

  return { start: startIso, step: 15, values };
}
