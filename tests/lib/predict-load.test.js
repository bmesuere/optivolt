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

// ... (omitted sections)

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
