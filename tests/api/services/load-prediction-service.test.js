import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { runForecast } from '../../../api/services/load-prediction-service.ts';

vi.mock('../../../api/services/ha-client.ts', () => ({
  fetchHaStats: vi.fn(),
}));

vi.mock('../../../api/services/open-meteo-client.ts', () => ({
  fetchTemperatureSeries: vi.fn(),
}));

import { fetchHaStats } from '../../../api/services/ha-client.ts';
import { fetchTemperatureSeries } from '../../../api/services/open-meteo-client.ts';

const NOW = new Date('2026-04-01T22:00:00.000Z');
const HOUR_MS = 3600 * 1000;

/** Hourly readings for the past `days` days, constant `value` per hour. */
function makeHourlyHistory(value, days = 8) {
  const nowHour = Math.floor(NOW.getTime() / HOUR_MS) * HOUR_MS;
  const readings = [];
  for (let k = 0; k <= days * 24; k++) {
    readings.push({ start: nowHour - k * HOUR_MS, change: value });
  }
  return readings;
}

describe('runForecast (fixed predictors only)', () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    fetchHaStats.mockReset();
  });

  it('returns a flat ForecastSeries equal to the sum of fixed predictors, without fetching HA', async () => {
    const config = {
      predictors: [
        { type: 'fixed', load_W: 300 },
        { type: 'fixed', load_W: 50 },
      ],
      sensors: [],
      derived: [],
      haUrl: '',
      haToken: '',
    };

    const result = await runForecast(config);

    expect(result.forecast.step).toBe(15);
    expect(result.forecast.values.length).toBeGreaterThan(0);
    expect(result.forecast.values.every(v => v === 350)).toBe(true);
    expect(result.recent).toHaveLength(0);
    expect(Number.isNaN(result.metrics.mae)).toBe(true);
    expect(result.metrics.n).toBe(0);
    expect(fetchHaStats).not.toHaveBeenCalled();
  });

  it('returns a flat 0 series when no predictors are configured', async () => {
    const result = await runForecast({ predictors: [], sensors: [], derived: [], haUrl: '', haToken: '' });
    expect(result.forecast.values.every(v => v === 0)).toBe(true);
  });
});

describe('runForecast (summed predictors)', () => {
  const sensors = [
    { id: 'sensor.base', name: 'Base', unit: 'Wh' },
    { id: 'sensor.heatpump', name: 'Heat Pump', unit: 'Wh' },
  ];
  const haConfig = { haUrl: 'http://ha.local', haToken: 'tok', sensors, derived: [] };
  const basePredictor = { type: 'historical', sensor: 'Base', lookbackWeeks: 1, dayFilter: 'all', aggregation: 'mean' };
  const heatPumpPredictor = { type: 'historical', sensor: 'Heat Pump', lookbackWeeks: 1, dayFilter: 'all', aggregation: 'mean' };

  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterAll(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    fetchHaStats.mockReset();
  });

  it('sums two historical predictors and a fixed predictor into the forecast', async () => {
    fetchHaStats.mockResolvedValue({
      'sensor.base': makeHourlyHistory(100),
      'sensor.heatpump': makeHourlyHistory(50),
    });

    const config = {
      predictors: [basePredictor, heatPumpPredictor, { type: 'fixed', load_W: 25 }],
      ...haConfig,
    };

    const result = await runForecast(config);

    expect(fetchHaStats).toHaveBeenCalledTimes(1);
    expect(result.forecast.step).toBe(15);
    expect(result.forecast.values.every(v => v === 175)).toBe(true);
  });

  it('compares summed historical predictions against summed actuals, excluding fixed terms', async () => {
    fetchHaStats.mockResolvedValue({
      'sensor.base': makeHourlyHistory(100),
      'sensor.heatpump': makeHourlyHistory(50),
    });

    const config = {
      predictors: [basePredictor, heatPumpPredictor, { type: 'fixed', load_W: 25 }],
      ...haConfig,
    };

    const result = await runForecast(config);

    expect(result.recent.length).toBeGreaterThan(0);
    const withPrediction = result.recent.filter(r => r.predicted !== null);
    expect(withPrediction.length).toBeGreaterThan(0);
    expect(withPrediction.every(r => r.actual === 150 && r.predicted === 150)).toBe(true);
    expect(result.metrics.mae).toBe(0);
    expect(result.metrics.n).toBeGreaterThan(0);
  });

  it('fetches history sized to the largest lookback among historical predictors', async () => {
    fetchHaStats.mockResolvedValue({
      'sensor.base': makeHourlyHistory(100),
      'sensor.heatpump': makeHourlyHistory(50),
    });

    const config = {
      predictors: [
        { ...basePredictor, lookbackWeeks: 2 },
        { ...heatPumpPredictor, lookbackWeeks: 6 },
      ],
      ...haConfig,
    };

    await runForecast(config);

    const { startTime } = fetchHaStats.mock.calls[0][0];
    // max lookback 6 weeks + 1 extra week for the recent-accuracy window
    const expected = new Date(NOW.getTime() - 7 * 7 * 24 * 3600 * 1000).toISOString();
    expect(startTime).toBe(expected);
  });

  it('skips recent accuracy when includeRecent is false', async () => {
    fetchHaStats.mockResolvedValue({
      'sensor.base': makeHourlyHistory(100),
    });

    const config = {
      predictors: [basePredictor],
      includeRecent: false,
      ...haConfig,
    };

    const result = await runForecast(config);

    expect(result.recent).toHaveLength(0);
    expect(Number.isNaN(result.metrics.mae)).toBe(true);
    expect(result.forecast.values.every(v => v === 100)).toBe(true);
  });
});

describe('runForecast (temperature predictor)', () => {
  const sensors = [{ id: 'sensor.heatpump', name: 'Heat Pump', unit: 'Wh' }];
  const haConfig = {
    haUrl: 'http://ha.local',
    haToken: 'tok',
    sensors,
    derived: [],
    pvConfig: { latitude: 51.05, longitude: 3.71, historyDays: 14, pvSensor: 'Solar' },
  };
  const tempPredictor = { type: 'temperature', sensor: 'Heat Pump', lookbackWeeks: 1, dayFilter: 'all', bins: 4 };

  /** Constant hourly temps covering 10 days back through 3 days ahead. */
  function makeTemps(temp_C) {
    const nowHour = Math.floor(NOW.getTime() / HOUR_MS) * HOUR_MS;
    const records = [];
    for (let k = -10 * 24; k <= 3 * 24; k++) {
      records.push({ time: nowHour + k * HOUR_MS, temp_C });
    }
    return records;
  }

  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterAll(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    fetchHaStats.mockReset();
    fetchTemperatureSeries.mockReset();
  });

  it('forecasts from temperature anchors and sums with fixed predictors', async () => {
    fetchHaStats.mockResolvedValue({ 'sensor.heatpump': makeHourlyHistory(100) });
    fetchTemperatureSeries.mockResolvedValue(makeTemps(10));

    const config = {
      predictors: [tempPredictor, { type: 'fixed', load_W: 25 }],
      ...haConfig,
    };

    const result = await runForecast(config);

    // Constant history at constant temperature → flat profile of 100 W
    expect(result.forecast.values.every(v => v === 125)).toBe(true);

    const withPrediction = result.recent.filter(r => r.predicted !== null);
    expect(withPrediction.length).toBeGreaterThan(0);
    expect(withPrediction.every(r => r.actual === 100 && r.predicted === 100)).toBe(true);
    expect(result.metrics.mae).toBe(0);

    // lookback 1 week + 1 recent week + 2 inertia days = 16 past days
    expect(fetchTemperatureSeries).toHaveBeenCalledTimes(1);
    const [lat, lon, pastDays, forecastDays] = fetchTemperatureSeries.mock.calls[0];
    expect(lat).toBe(51.05);
    expect(lon).toBe(3.71);
    expect(pastDays).toBe(16);
    expect(forecastDays).toBeGreaterThanOrEqual(2);
  });

  it('rejects when no coordinates are configured', async () => {
    fetchHaStats.mockResolvedValue({ 'sensor.heatpump': makeHourlyHistory(100) });

    const config = {
      predictors: [tempPredictor],
      ...haConfig,
      pvConfig: undefined,
    };

    await expect(runForecast(config)).rejects.toThrow(/latitude\/longitude/);
    expect(fetchTemperatureSeries).not.toHaveBeenCalled();
  });
});
