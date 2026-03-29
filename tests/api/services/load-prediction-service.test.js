import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { runForecast } from '../../../api/services/load-prediction-service.ts';

describe('runForecast (fixed predictor)', () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T22:00:00.000Z'));
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it('returns a flat ForecastSeries with all values equal to load_W', async () => {
    const config = {
      activeType: 'fixed',
      fixedPredictor: { load_W: 300 },
      historicalPredictor: undefined,
      sensors: [],
      derived: [],
      haUrl: '',
      haToken: '',
    };

    const result = await runForecast(config);

    expect(result.forecast.step).toBe(15);
    expect(result.forecast.values.length).toBeGreaterThan(0);
    expect(result.forecast.values.every(v => v === 300)).toBe(true);
    expect(result.recent).toHaveLength(0);
    expect(Number.isNaN(result.metrics.mae)).toBe(true);
    expect(result.metrics.n).toBe(0);
  });

  it('uses the fixed load_W value verbatim', async () => {
    const config = {
      activeType: 'fixed',
      fixedPredictor: { load_W: 50 },
      historicalPredictor: undefined,
      sensors: [],
      derived: [],
      haUrl: '',
      haToken: '',
    };

    const result = await runForecast(config);
    expect(result.forecast.values.every(v => v === 50)).toBe(true);
  });
});
