import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { runForecast } from '../../../api/services/load-prediction-service.ts';

vi.mock('../../../api/services/ha-client.ts', () => ({
  fetchHaStats: vi.fn(),
}));

import { fetchHaStats } from '../../../api/services/ha-client.ts';

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

describe('runForecast (fixed predictor with accuracy)', () => {
  const baseTime = new Date('2026-04-01T22:00:00.000Z').getTime();

  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T22:00:00.000Z'));
  });

  afterAll(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    fetchHaStats.mockReset();
  });

  function makeRawData(entityId, hoursAgoList, values) {
    return {
      [entityId]: hoursAgoList.map((hoursAgo, i) => ({
        start: baseTime - hoursAgo * 3600 * 1000,
        change: values[i],
      })),
    };
  }

  const sensors = [{ id: 'sensor.load', name: 'Load', unit: 'W' }];
  const haConfig = { haUrl: 'http://ha.local', haToken: 'tok', sensors, derived: [] };

  it('returns recent accuracy data when sensor and HA are configured', async () => {
    fetchHaStats.mockResolvedValue(
      makeRawData('sensor.load', [2, 4, 6], [280, 320, 300])
    );

    const config = {
      activeType: 'fixed',
      fixedPredictor: { load_W: 300 },
      historicalPredictor: { sensor: 'Load', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean' },
      ...haConfig,
    };

    const result = await runForecast(config);

    expect(result.forecast.values.every(v => v === 300)).toBe(true);
    expect(result.recent.length).toBeGreaterThan(0);
    expect(result.recent.every(r => r.predicted === 300)).toBe(true);
    expect(Number.isFinite(result.metrics.mae)).toBe(true);
    expect(result.metrics.n).toBeGreaterThan(0);
  });

  it('skips accuracy when includeRecent is false', async () => {
    const config = {
      activeType: 'fixed',
      fixedPredictor: { load_W: 300 },
      historicalPredictor: { sensor: 'Load', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean' },
      includeRecent: false,
      ...haConfig,
    };

    const result = await runForecast(config);

    expect(result.recent).toHaveLength(0);
    expect(Number.isNaN(result.metrics.mae)).toBe(true);
    expect(fetchHaStats).not.toHaveBeenCalled();
  });
});
