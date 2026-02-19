import { describe, it, expect } from 'vitest';
import {
  getDayBucket,
  mean,
  median,
  predict,
  validate,
  generateAllConfigs,
  buildForecastSeriesRange,
} from '../../lib/predict-load.js';

// ---------------------------------------------------------------------------
// getDayBucket
// ---------------------------------------------------------------------------

describe('getDayBucket', () => {
  it('same: returns day of week as-is', () => {
    expect(getDayBucket(1, 'same')).toBe(1);
    expect(getDayBucket(0, 'same')).toBe(0);
  });

  it('weekday-weekend: buckets Mon-Fri as weekday', () => {
    for (const day of [1, 2, 3, 4, 5]) {
      expect(getDayBucket(day, 'weekday-weekend')).toBe('weekday');
    }
  });

  it('weekday-weekend: buckets Sun and Sat as weekend', () => {
    expect(getDayBucket(0, 'weekday-weekend')).toBe('weekend');
    expect(getDayBucket(6, 'weekday-weekend')).toBe('weekend');
  });

  it('weekday-sat-sun: distinguishes saturday and sunday', () => {
    expect(getDayBucket(6, 'weekday-sat-sun')).toBe('saturday');
    expect(getDayBucket(0, 'weekday-sat-sun')).toBe('sunday');
    expect(getDayBucket(3, 'weekday-sat-sun')).toBe('weekday');
  });

  it('all: always returns "all"', () => {
    for (const day of [0, 1, 2, 3, 4, 5, 6]) {
      expect(getDayBucket(day, 'all')).toBe('all');
    }
  });

  it('unknown filter: falls back to "all"', () => {
    expect(getDayBucket(3, 'unknown')).toBe('all');
  });
});

// ---------------------------------------------------------------------------
// mean / median
// ---------------------------------------------------------------------------

describe('mean', () => {
  it('computes arithmetic mean', () => {
    expect(mean([1, 2, 3])).toBeCloseTo(2);
    expect(mean([10, 20])).toBeCloseTo(15);
  });
});

describe('median', () => {
  it('returns middle value for odd-length array', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('returns average of two middle values for even-length array', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('does not mutate the input array', () => {
    const arr = [3, 1, 2];
    median(arr);
    expect(arr).toEqual([3, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// predict
// ---------------------------------------------------------------------------

// Build a small history: Mon–Fri for 3 weeks, sensor "Load", hour 10
const BASE_TIME = new Date('2026-01-05T10:00:00.000Z').getTime(); // Monday

function makeEntry(weekOffset, dayOffset, value) {
  const t = BASE_TIME + (weekOffset * 7 + dayOffset) * 24 * 60 * 60 * 1000;
  const d = new Date(t);
  return {
    date: d.toISOString(),
    time: t,
    hour: d.getUTCHours(),
    dayOfWeek: d.getUTCDay(),
    sensor: 'Load',
    value,
  };
}

// 3 weeks of Mon–Fri history with value = week*100 + day
const history = [];
for (let w = 0; w < 3; w++) {
  for (let day = 0; day < 5; day++) {
    history.push(makeEntry(w, day, w * 100 + day * 10));
  }
}

// Target: the 4th Monday (week 3, day 0)
const targetTs = BASE_TIME + 3 * 7 * 24 * 60 * 60 * 1000;
const targetEntry = {
  date: new Date(targetTs).toISOString(),
  time: targetTs,
  hour: 10,
  dayOfWeek: 1, // Monday
  value: null,
};

describe('predict', () => {
  it('returns null predicted when no history available', () => {
    const results = predict([], { sensor: 'Load', lookbackWeeks: 1, dayFilter: 'same', aggregation: 'mean' });
    expect(results).toHaveLength(0);
  });

  it('predicts using same-day filter (only Mondays)', () => {
    const results = predict(history, {
      sensor: 'Load',
      lookbackWeeks: 4,
      dayFilter: 'same',
      aggregation: 'mean',
    }, [targetEntry]);

    expect(results).toHaveLength(1);
    // 3 Monday values: 0, 100, 200 → mean = 100
    expect(results[0].predicted).toBeCloseTo(100);
    expect(results[0].actual).toBeNull();
  });

  it('predicts using weekday-weekend filter (Mon-Fri pooled)', () => {
    const results = predict(history, {
      sensor: 'Load',
      lookbackWeeks: 4,
      dayFilter: 'weekday-weekend',
      aggregation: 'mean',
    }, [targetEntry]);

    expect(results).toHaveLength(1);
    expect(results[0].predicted).not.toBeNull();
  });

  it('uses median aggregation', () => {
    const results = predict(history, {
      sensor: 'Load',
      lookbackWeeks: 4,
      dayFilter: 'same',
      aggregation: 'median',
    }, [targetEntry]);

    // Mondays: 0, 100, 200 → median = 100
    expect(results[0].predicted).toBeCloseTo(100);
  });

  it('returns null predicted when lookback too short to find matching days', () => {
    const results = predict(history, {
      sensor: 'Load',
      lookbackWeeks: 1,
      dayFilter: 'same',
      aggregation: 'mean',
    }, [targetEntry]);

    // Only looks back 7 days — the previous Monday is within range
    expect(results[0].predicted).not.toBeNull();
  });

  it('predicts for all history entries when no targets provided', () => {
    const results = predict(history, {
      sensor: 'Load',
      lookbackWeeks: 4,
      dayFilter: 'same',
      aggregation: 'mean',
    });

    expect(results).toHaveLength(history.length);
  });
});

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

describe('validate', () => {
  const window = { start: '2026-01-12T00:00:00.000Z', end: '2026-01-19T00:00:00.000Z' };

  const inWindowTs = new Date('2026-01-13T10:00:00.000Z').getTime();
  const outWindowTs = new Date('2026-01-05T10:00:00.000Z').getTime();

  it('returns NaN metrics when no predictions in window', () => {
    const metrics = validate([], window);
    expect(metrics.n).toBe(0);
    expect(isNaN(metrics.mae)).toBe(true);
  });

  it('ignores predictions outside the window', () => {
    const predictions = [{ time: outWindowTs, actual: 100, predicted: 80 }];
    const metrics = validate(predictions, window);
    expect(metrics.n).toBe(0);
  });

  it('counts skipped predictions (null predicted)', () => {
    const predictions = [
      { time: inWindowTs, actual: 100, predicted: null },
    ];
    const metrics = validate(predictions, window);
    expect(metrics.nSkipped).toBe(1);
    expect(metrics.n).toBe(0);
  });

  it('computes MAE correctly', () => {
    const predictions = [
      { time: inWindowTs, actual: 100, predicted: 80 },
      { time: inWindowTs + 3600000, actual: 200, predicted: 210 },
    ];
    const metrics = validate(predictions, window);
    // |100-80| + |200-210| = 20 + 10 = 30 → MAE = 15
    expect(metrics.mae).toBeCloseTo(15);
    expect(metrics.n).toBe(2);
  });

  it('computes RMSE correctly', () => {
    const predictions = [
      { time: inWindowTs, actual: 100, predicted: 90 },
    ];
    const metrics = validate(predictions, window);
    expect(metrics.rmse).toBeCloseTo(10);
  });

  it('skips MAPE for near-zero actuals', () => {
    const predictions = [
      { time: inWindowTs, actual: 3, predicted: 1 }, // |actual| <= 5, excluded from MAPE
    ];
    const metrics = validate(predictions, window);
    expect(isNaN(metrics.mape)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// generateAllConfigs
// ---------------------------------------------------------------------------

describe('generateAllConfigs', () => {
  it('generates correct count of combinations', () => {
    const configs = generateAllConfigs(['Load', 'Net']);
    // 2 sensors × 6 lookbacks × 4 dayFilters × 2 aggregations = 96
    expect(configs).toHaveLength(96);
  });

  it('includes all sensor names', () => {
    const configs = generateAllConfigs(['A', 'B']);
    const sensors = [...new Set(configs.map(c => c.sensor))];
    expect(sensors).toContain('A');
    expect(sensors).toContain('B');
  });

  it('respects custom lookbacks', () => {
    const configs = generateAllConfigs(['Load'], [1, 2]);
    const lookbacks = [...new Set(configs.map(c => c.lookbackWeeks))];
    expect(lookbacks).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// buildForecastSeriesRange
// ---------------------------------------------------------------------------

describe('buildForecastSeriesRange', () => {
  const startIso = '2026-02-20T00:00:00.000Z';
  const endIso = '2026-02-21T00:00:00.000Z';

  it('produces 96 slots for 24 hours', () => {
    const { values } = buildForecastSeriesRange([], startIso, endIso);
    expect(values).toHaveLength(96);
  });

  it('fills 0 for missing hours', () => {
    const { values } = buildForecastSeriesRange([], startIso, endIso);
    expect(values.every(v => v === 0)).toBe(true);
  });

  it('repeats hourly value across 4 slots', () => {
    const predictions = [
      { date: '2026-02-20T10:00:00.000Z', time: new Date('2026-02-20T10:00:00.000Z').getTime(), hour: 10, predicted: 400 },
    ];
    const { values } = buildForecastSeriesRange(predictions, startIso, endIso);
    // Hour 10 → slots 40-43
    expect(values[40]).toBe(400);
    expect(values[41]).toBe(400);
    expect(values[42]).toBe(400);
    expect(values[43]).toBe(400);
  });

  it('sets correct start ISO string', () => {
    const { start, step } = buildForecastSeriesRange([], startIso, endIso);
    expect(start).toBe(startIso);
    expect(step).toBe(15);
  });

  it('ignores null predictions', () => {
    const predictions = [
      { date: '2026-02-20T05:00:00.000Z', time: new Date('2026-02-20T05:00:00.000Z').getTime(), hour: 5, predicted: null },
    ];
    const { values } = buildForecastSeriesRange(predictions, startIso, endIso);
    expect(values[20]).toBe(0);
  });
});
