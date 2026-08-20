import { describe, it, expect } from 'vitest';
import { extractWindow, getQuarterStart, buildForecastSeries, getForecastTimeRange, dayAheadWindowEndMs, extendSeriesWithForecast } from '../../lib/time-series-utils.ts';

describe('Time Series Utils', () => {
  describe('getQuarterStart', () => {
    it('rounds down to the nearest 15 minutes', () => {
      const d = new Date('2024-01-01T10:22:00Z');
      const start = getQuarterStart(d);
      expect(new Date(start).toISOString()).toBe('2024-01-01T10:15:00.000Z');
    });

    it('handles exact 15 minute boundaries', () => {
      const d = new Date('2024-01-01T10:30:00.000Z');
      const start = getQuarterStart(d);
      expect(new Date(start).toISOString()).toBe('2024-01-01T10:30:00.000Z');
    });
  });

  describe('extractWindow', () => {
    const stepMs = 15 * 60 * 1000;
    const baseTime = new Date('2024-01-01T10:00:00Z').getTime();

    const source = {
      start: new Date(baseTime).toISOString(),
      step: 15,
      // 0: 10:00, 1: 10:15, 2: 10:30, 3: 10:45, 4: 11:00
      values: [10, 20, 30, 40, 50],
    };

    it('extracts an exact matching window', () => {
      // Window: 10:00 to 11:15 (5 slots)
      const result = extractWindow(source, baseTime, baseTime + 5 * stepMs);
      expect(result).toEqual([10, 20, 30, 40, 50]);
    });

    it('extracts a subset (start offset)', () => {
      // Request 10:30 (index 2) to 11:00 (index 4 is 11:00, exclusive? logic says duration/step)
      // 10:30 to 11:00 is 2 slots: 10:30, 10:45
      const start = baseTime + 2 * stepMs; // 10:30
      const end = baseTime + 4 * stepMs;   // 11:00
      const result = extractWindow(source, start, end);
      expect(result).toEqual([30, 40]);
    });

    it('handles source starting AFTER target (pads start)', () => {
      // Request 09:45 to 10:30
      // 09:45 (pad), 10:00 (10), 10:15 (20)
      const start = baseTime - 1 * stepMs; // 09:45
      const end = baseTime + 2 * stepMs;   // 10:30
      const result = extractWindow(source, start, end);
      expect(result).toEqual([0, 10, 20]);
    });

    it('handles source ending BEFORE target (pads end)', () => {
      // Request 11:00 to 11:30
      // Source has 11:00 at index 4 (50).
      // Wait, 10:00 + 4*15 = 11:00. Index 4 is the slot STARTING at 11:00.
      // Source length 5 means we have slots starting at: 10:00, 10:15, 10:30, 10:45, 11:00.
      // So index 4 is valid for 11:00.

      // Let's ask for 11:00 to 11:45 (3 slots: 11:00, 11:15, 11:30)
      // Exists: 11:00 (50).
      // Missing: 11:15, 11:30.
      const start = baseTime + 4 * stepMs; // 11:00
      const end = baseTime + 7 * stepMs;   // 11:45
      const result = extractWindow(source, start, end);
      expect(result).toEqual([50, 0, 0]);
    });

    it('repeats coarser source values when resampling to a finer target step', () => {
      const hourly = {
        start: new Date(baseTime).toISOString(),
        step: 60,
        values: [100, 200],
      };

      const result = extractWindow(hourly, baseTime, baseTime + 2 * 60 * 60 * 1000, 15);

      expect(result).toEqual([100, 100, 100, 100, 200, 200, 200, 200]);
    });

    it('averages finer source values when resampling to a coarser target step', () => {
      const result = extractWindow(source, baseTime, baseTime + 60 * 60 * 1000, 60);

      expect(result).toEqual([25]);
    });
  });
});

// ---------------------------------------------------------------------------
// buildForecastSeries
// ---------------------------------------------------------------------------

describe('buildForecastSeries', () => {
  it('repeats hourly values 4× when inputStep=60 (default)', () => {
    const start = new Date('2024-06-15T10:00:00Z').toISOString();
    const end = new Date('2024-06-15T12:00:00Z').toISOString();
    const points = [
      { time: new Date('2024-06-15T10:00:00Z').getTime(), value: 1000 },
      { time: new Date('2024-06-15T11:00:00Z').getTime(), value: 2000 },
    ];

    const series = buildForecastSeries(points, start, end);
    expect(series.values).toHaveLength(8); // 2 hours × 4 slots
    expect(series.values.slice(0, 4)).toEqual([1000, 1000, 1000, 1000]);
    expect(series.values.slice(4, 8)).toEqual([2000, 2000, 2000, 2000]);
  });

  it('maps 15-min points directly when inputStep=15', () => {
    const start = new Date('2024-06-15T10:00:00Z').toISOString();
    const end = new Date('2024-06-15T10:45:00Z').toISOString();
    const points = [
      { time: new Date('2024-06-15T10:00:00Z').getTime(), value: 100 },
      { time: new Date('2024-06-15T10:15:00Z').getTime(), value: 200 },
      { time: new Date('2024-06-15T10:30:00Z').getTime(), value: 300 },
    ];

    const series = buildForecastSeries(points, start, end, 15);
    expect(series.values).toHaveLength(3);
    expect(series.values).toEqual([100, 200, 300]);
  });

  it('fills missing 15-min slots with 0 when inputStep=15', () => {
    const start = new Date('2024-06-15T10:00:00Z').toISOString();
    const end = new Date('2024-06-15T11:00:00Z').toISOString();
    // Only provide 2 of the 4 15-min slots
    const points = [
      { time: new Date('2024-06-15T10:00:00Z').getTime(), value: 100 },
      { time: new Date('2024-06-15T10:30:00Z').getTime(), value: 300 },
    ];

    const series = buildForecastSeries(points, start, end, 15);
    expect(series.values).toHaveLength(4);
    expect(series.values).toEqual([100, 0, 300, 0]);
  });

  it('returns all zeros when no points provided (inputStep=15)', () => {
    const start = new Date('2024-06-15T10:00:00Z').toISOString();
    const end = new Date('2024-06-15T11:00:00Z').toISOString();

    const series = buildForecastSeries([], start, end, 15);
    expect(series.values).toHaveLength(4);
    expect(series.values.every(v => v === 0)).toBe(true);
  });
});

describe('dayAheadWindowEndMs', () => {
  // Times are interpreted in local time; use explicit local Date values.
  it('ends at midnight tonight before 13:00', () => {
    const now = new Date(2024, 0, 1, 12, 59, 59, 999);
    expect(dayAheadWindowEndMs(now.getTime())).toBe(new Date(2024, 0, 2, 0, 0, 0).getTime());
  });

  it('ends at midnight tomorrow from 13:00 onwards', () => {
    const now = new Date(2024, 0, 1, 13, 0, 0);
    expect(dayAheadWindowEndMs(now.getTime())).toBe(new Date(2024, 0, 3, 0, 0, 0).getTime());
  });

  it('rolls over the month and year at the boundary', () => {
    const now = new Date(2024, 11, 31, 13, 0, 0);
    expect(dayAheadWindowEndMs(now.getTime())).toBe(new Date(2025, 0, 2, 0, 0, 0).getTime());
  });

  it('adds whole extra days for the extended horizon', () => {
    const now = new Date(2024, 0, 1, 10, 0, 0);
    expect(dayAheadWindowEndMs(now.getTime(), 3)).toBe(new Date(2024, 0, 5, 0, 0, 0).getTime());
  });
});

describe('getForecastTimeRange', () => {
  // Times are interpreted in local time; use explicit local Date values.
  it('extends the end by extraDays', () => {
    const now = new Date(2024, 0, 1, 10, 0, 0); // 10:00 local, before 13:00
    const base = getForecastTimeRange(now.getTime());
    const extended = getForecastTimeRange(now.getTime(), 3);
    const dayMs = 24 * 60 * 60 * 1000;
    expect(new Date(extended.endIso).getTime() - new Date(base.endIso).getTime()).toBe(3 * dayMs);
    expect(extended.startIso).toBe(base.startIso);
  });

  it('defaults to the standard window when extraDays is omitted', () => {
    const now = new Date(2024, 0, 1, 14, 0, 0); // after 13:00 → midnight tomorrow
    const { endIso } = getForecastTimeRange(now.getTime());
    expect(new Date(endIso).getTime()).toBe(new Date(2024, 0, 3, 0, 0, 0).getTime());
  });
});

describe('extendSeriesWithForecast', () => {
  const startMs = new Date('2024-01-01T10:00:00Z').getTime();
  const stepMs = 15 * 60 * 1000;
  const actual = {
    start: new Date(startMs).toISOString(),
    step: 15,
    values: [10, 11, 12, 13], // ends 11:00
  };

  it('appends only the forecast tail past the end of the actual series', () => {
    const forecast = {
      start: new Date(startMs + 2 * stepMs).toISOString(), // 10:30, overlaps actual
      step: 15,
      values: [99, 99, 20, 21, 22], // 10:30..11:45; tail past 11:00 = [20, 21, 22]
    };
    const merged = extendSeriesWithForecast(actual, forecast);
    expect(merged.start).toBe(actual.start);
    expect(merged.values).toEqual([10, 11, 12, 13, 20, 21, 22]);
  });

  it('returns the actual series unchanged when there is no forecast', () => {
    expect(extendSeriesWithForecast(actual, undefined)).toBe(actual);
    expect(extendSeriesWithForecast(actual, { start: actual.start, step: 15, values: [] })).toBe(actual);
  });

  it('returns the actual series unchanged when the forecast ends before the actual data', () => {
    const forecast = { start: actual.start, step: 15, values: [1, 2] };
    expect(extendSeriesWithForecast(actual, forecast)).toBe(actual);
  });

  it('returns the actual series unchanged when the forecast starts after the actual data ends (gap)', () => {
    const forecast = {
      start: new Date(startMs + 5 * stepMs).toISOString(), // 11:15, actual ends 11:00
      step: 15,
      values: [20, 21],
    };
    expect(extendSeriesWithForecast(actual, forecast)).toBe(actual);
  });

  it('accepts a forecast starting exactly where the actual series ends', () => {
    const forecast = {
      start: new Date(startMs + 4 * stepMs).toISOString(), // 11:00
      step: 15,
      values: [20, 21],
    };
    const merged = extendSeriesWithForecast(actual, forecast);
    expect(merged.values).toEqual([10, 11, 12, 13, 20, 21]);
  });

  it('resamples a coarser forecast to the actual step', () => {
    const forecast = {
      start: new Date(startMs + 4 * stepMs).toISOString(), // 11:00
      step: 60,
      values: [40], // one hour → four 15-min slots
    };
    const merged = extendSeriesWithForecast(actual, forecast);
    expect(merged.values).toEqual([10, 11, 12, 13, 40, 40, 40, 40]);
  });
});
