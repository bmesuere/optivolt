import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyAdjustmentsToForecastSeries,
  buildForecastSelectionRange,
  forecastSeriesFromCategoryX,
  futureForecastSeries,
} from '../../app/src/predictions.js';

describe('prediction adjustment UI helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2099-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('maps a dragged hourly range to whole-hour ISO bounds', () => {
    const timestamps = [
      Date.parse('2099-01-01T18:00:00.000Z'),
      Date.parse('2099-01-01T19:00:00.000Z'),
      Date.parse('2099-01-01T20:00:00.000Z'),
    ];

    expect(buildForecastSelectionRange(2, 1, timestamps, 60)).toEqual({
      startIndex: 1,
      endIndex: 2,
      start: '2099-01-01T19:00:00.000Z',
      end: '2099-01-01T21:00:00.000Z',
    });
  });

  it('maps a 15-minute slot click to one 15-minute interval', () => {
    const timestamps = [
      Date.parse('2099-01-01T19:00:00.000Z'),
      Date.parse('2099-01-01T19:15:00.000Z'),
    ];

    expect(buildForecastSelectionRange(1, 1, timestamps, 15)).toEqual({
      startIndex: 1,
      endIndex: 1,
      start: '2099-01-01T19:15:00.000Z',
      end: '2099-01-01T19:30:00.000Z',
    });
  });

  it('maps empty grouped-chart bucket clicks to load and pv lanes', () => {
    const bounds = { left: 100, right: 180 };

    expect(forecastSeriesFromCategoryX(112, bounds)).toBe('load');
    expect(forecastSeriesFromCategoryX(168, bounds)).toBe('pv');
  });

  it('applies active manual adjustments to raw forecast copies', () => {
    const forecast = {
      start: '2099-01-01T19:00:00.000Z',
      step: 15,
      values: [100, 100, 100],
    };

    const adjusted = applyAdjustmentsToForecastSeries(forecast, [
      { series: 'load', mode: 'add', value_W: 75, start: '2099-01-01T19:15:00.000Z', end: '2099-01-01T19:45:00.000Z' },
    ], 'load');

    expect(adjusted.values).toEqual([100, 175, 175]);
    expect(forecast.values).toEqual([100, 100, 100]);
  });

  it('slices stored data to the current forecast slot for dev/default data hydration', () => {
    const series = {
      start: '2099-01-01T18:00:00.000Z',
      step: 15,
      values: [10, 20, 30, 40, 50],
    };

    expect(futureForecastSeries(series, Date.parse('2099-01-01T18:32:00.000Z'))).toEqual({
      start: '2099-01-01T18:30:00.000Z',
      step: 15,
      values: [30, 40, 50],
    });
  });

  it('returns null when stored data has no future slots', () => {
    const series = {
      start: '2099-01-01T18:00:00.000Z',
      step: 15,
      values: [10, 20],
    };

    expect(futureForecastSeries(series, Date.parse('2099-01-01T19:00:00.000Z'))).toBeNull();
  });
});
