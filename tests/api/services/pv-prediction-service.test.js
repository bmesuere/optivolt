import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../api/services/ha-client.ts', () => ({
  fetchHaStats: vi.fn(),
}));

vi.mock('../../../api/services/open-meteo-client.ts', () => ({
  fetchArchiveIrradiance: vi.fn(),
  fetchForecastIrradiance: vi.fn(),
}));

import { fetchHaStats } from '../../../api/services/ha-client.ts';
import { fetchArchiveIrradiance, fetchForecastIrradiance } from '../../../api/services/open-meteo-client.ts';
import { runPvForecast } from '../../../api/services/pv-prediction-service.ts';

const sensors = [{ id: 'sensor.pv', name: 'Solar Generation', unit: 'Wh' }];

function fiveMinutePvReadings(day, slotStartHour, watts) {
  const start = Date.UTC(2024, 5, day, slotStartHour);
  const whPerFiveMinutes = watts / 12;
  return [0, 5, 10].map(minutes => ({
    start: start + minutes * 60_000,
    change: whPerFiveMinutes,
  }));
}

function hourlyIrradiance(day, hour, direct, diffuse) {
  const time = Date.UTC(2024, 5, day, hour);
  return {
    time,
    hour,
    ghi_W_per_m2: direct + diffuse,
    directRadiation_W_per_m2: direct,
    diffuseRadiation_W_per_m2: diffuse,
    intervalMinutes: 60,
  };
}

function forecastIrradiance(day, hour, direct, diffuse) {
  return {
    ...hourlyIrradiance(day, hour, direct, diffuse),
    intervalMinutes: 15,
  };
}

describe('runPvForecast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-20T11:45:00Z'));
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns historical accuracy points and metrics for robustLinear 15min mode', async () => {
    fetchHaStats.mockResolvedValue({
      'sensor.pv': [
        ...fiveMinutePvReadings(16, 12, 1500),
        ...fiveMinutePvReadings(17, 12, 1800),
        ...fiveMinutePvReadings(18, 12, 2100),
        ...fiveMinutePvReadings(19, 12, 120),
      ],
    });
    fetchArchiveIrradiance.mockResolvedValue([
      hourlyIrradiance(16, 12, 500, 100),
      hourlyIrradiance(17, 12, 400, 200),
      hourlyIrradiance(18, 12, 300, 300),
      hourlyIrradiance(19, 12, 480, 120),
    ]);
    fetchForecastIrradiance.mockResolvedValue([
      forecastIrradiance(20, 12, 350, 250),
    ]);

    const result = await runPvForecast({
      sensors,
      derived: [],
      activeType: 'historical',
      historicalPredictor: { sensor: 'Grid', lookbackWeeks: 4, dayFilter: 'all', aggregation: 'mean' },
      pvConfig: {
        latitude: 51.05,
        longitude: 3.71,
        historyDays: 7,
        pvSensor: 'Solar Generation',
        pvMode: '15min',
        pvModel: 'robustLinear',
      },
      haUrl: 'ws://ha.local/api/websocket',
      haToken: 'token',
    });

    expect(fetchHaStats).toHaveBeenCalledWith(expect.objectContaining({ period: '5minute' }));
    expect(result.model).toBe('robustLinear');
    expect(result.forecast.step).toBe(15);
    expect(result.recent.length).toBeGreaterThan(0);
    expect(result.metrics.n).toBeGreaterThan(0);
  });
});
