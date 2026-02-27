import { describe, it, expect, vi } from 'vitest';
import {
  calculateClearSkyGHI,
  calculateMaxProductionPerHour,
  calculateMaxRatioPerHour,
  estimateHourlyCapacity,
  forecastPv,
  validatePvForecast,
} from '../../lib/predict-pv.ts';
import { buildForecastSeries } from '../../lib/time-series-utils.ts';

vi.mock('../../lib/open-meteo-client.ts');
vi.mock('../../lib/time-series-utils.ts', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
  };
});

// ---------------------------------------------------------------------------
// Bird Clear Sky Model
// ---------------------------------------------------------------------------

describe('calculateClearSkyGHI', () => {
  it('returns 0 at night (sun below horizon)', () => {
    // Ghent, Belgium at midnight UTC in June
    const date = new Date('2024-06-15T00:00:00Z');
    const ghi = calculateClearSkyGHI(51.05, 3.71, date);
    expect(ghi).toBe(0);
  });

  it('returns 0 at night in winter', () => {
    // Ghent, Belgium at 20:00 UTC in December
    const date = new Date('2024-12-15T20:00:00Z');
    const ghi = calculateClearSkyGHI(51.05, 3.71, date);
    expect(ghi).toBe(0);
  });

  it('returns positive GHI at solar noon in summer', () => {
    // Ghent, Belgium around solar noon in June
    const date = new Date('2024-06-15T12:00:00Z');
    const ghi = calculateClearSkyGHI(51.05, 3.71, date);
    expect(ghi).toBeGreaterThan(500);
    expect(ghi).toBeLessThan(1200);
  });

  it('returns positive GHI in the morning', () => {
    // Ghent, Belgium at 8:00 UTC in June
    const date = new Date('2024-06-15T08:00:00Z');
    const ghi = calculateClearSkyGHI(51.05, 3.71, date);
    expect(ghi).toBeGreaterThan(100);
    expect(ghi).toBeLessThan(800);
  });

  it('produces a bell curve throughout the day', () => {
    const values = [];
    for (let h = 4; h <= 21; h++) {
      const date = new Date(`2024-06-15T${String(h).padStart(2, '0')}:30:00Z`);
      values.push(calculateClearSkyGHI(51.05, 3.71, date));
    }
    // Should have some zeros at edges and a peak in the middle
    const maxVal = Math.max(...values);
    const maxIdx = values.indexOf(maxVal);
    // Peak should be roughly in the middle (around solar noon)
    expect(maxIdx).toBeGreaterThan(3);
    expect(maxIdx).toBeLessThan(14);
    expect(maxVal).toBeGreaterThan(500);
  });

  it('returns higher GHI near equator than at high latitude (same time, summer)', () => {
    const date = new Date('2024-06-15T12:00:00Z');
    const ghiEquator = calculateClearSkyGHI(0, 0, date);
    const ghiNorth = calculateClearSkyGHI(60, 0, date);
    expect(ghiEquator).toBeGreaterThan(ghiNorth);
  });

  it('handles southern hemisphere', () => {
    // Sydney, Australia at noon UTC (late evening local, should be 0 or near 0)
    const dateNight = new Date('2024-06-15T12:00:00Z');
    const ghiNight = calculateClearSkyGHI(-33.87, 151.21, dateNight);
    // At midnight local, should be 0
    expect(ghiNight).toBe(0);

    // Sydney at ~2:00 UTC = ~12:00 local in summer (December)
    const dateDaySummer = new Date('2024-12-15T02:00:00Z');
    const ghiDay = calculateClearSkyGHI(-33.87, 151.21, dateDaySummer);
    expect(ghiDay).toBeGreaterThan(400);
  });
});

// ---------------------------------------------------------------------------
// calculateMaxProductionPerHour
// ---------------------------------------------------------------------------

describe('calculateMaxProductionPerHour', () => {
  it('returns array of length 24', () => {
    const result = calculateMaxProductionPerHour([]);
    expect(result).toHaveLength(24);
    expect(result.every(v => v === 0)).toBe(true);
  });

  it('tracks max production per hour across multiple days', () => {
    const records = [
      { time: Date.UTC(2024, 5, 15, 10), hour: 10, production_Wh: 500 },
      { time: Date.UTC(2024, 5, 16, 10), hour: 10, production_Wh: 700 },
      { time: Date.UTC(2024, 5, 15, 12), hour: 12, production_Wh: 1000 },
      { time: Date.UTC(2024, 5, 16, 12), hour: 12, production_Wh: 800 },
    ];

    const result = calculateMaxProductionPerHour(records);
    expect(result[10]).toBe(700);
    expect(result[12]).toBe(1000);
    expect(result[0]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// calculateMaxRatioPerHour
// ---------------------------------------------------------------------------

describe('calculateMaxRatioPerHour', () => {
  it('returns array of length 24 with all zeros for empty input', () => {
    const result = calculateMaxRatioPerHour([], 51.05, 3.71);
    expect(result).toHaveLength(24);
    expect(result.every(v => v === 0)).toBe(true);
  });

  it('computes ratio for daytime records', () => {
    // Create irradiance records at hour 12 in summer (should have good GHI)
    const records = [
      { time: Date.UTC(2024, 5, 15, 12), hour: 12, ghi_W_per_m2: 600, intervalMinutes: 60 },
    ];

    const result = calculateMaxRatioPerHour(records, 51.05, 3.71);
    // Hour 12 should have a positive ratio
    expect(result[12]).toBeGreaterThan(0);
  });

  it('skips nighttime records where ghiClear < 20', () => {
    const records = [
      { time: Date.UTC(2024, 5, 15, 1), hour: 1, ghi_W_per_m2: 0, intervalMinutes: 60 },
    ];

    const result = calculateMaxRatioPerHour(records, 51.05, 3.71);
    expect(result[1]).toBe(0);
  });

  it('uses intervalMinutes for mid-interval calculation (15-min record uses 7.5 min offset)', () => {
    // For a 15-min record, mid-interval is 7.5 min after start
    // For a 60-min record, mid-interval is 30 min after start
    // Both should produce non-zero ratios for a daytime record
    const timeMs = Date.UTC(2024, 5, 15, 12);
    const record15 = { time: timeMs, hour: 12, ghi_W_per_m2: 600, intervalMinutes: 15 };
    const record60 = { time: timeMs, hour: 12, ghi_W_per_m2: 600, intervalMinutes: 60 };

    const result15 = calculateMaxRatioPerHour([record15], 51.05, 3.71);
    const result60 = calculateMaxRatioPerHour([record60], 51.05, 3.71);

    // Both should yield positive ratios; they may differ due to different mid-interval times
    expect(result15[12]).toBeGreaterThan(0);
    expect(result60[12]).toBeGreaterThan(0);
    // The ratios should differ since the Bird model is evaluated at different times
    expect(result15[12]).not.toBeCloseTo(result60[12], 10);
  });
});

// ---------------------------------------------------------------------------
// estimateHourlyCapacity
// ---------------------------------------------------------------------------

describe('estimateHourlyCapacity', () => {
  it('computes trueCapacity as maxProd / maxRatio when ratio > 0.1', () => {
    const maxProd = new Array(24).fill(0);
    const maxRatio = new Array(24).fill(0);
    maxProd[12] = 1000;
    maxRatio[12] = 0.5;

    const capacity = estimateHourlyCapacity(maxProd, maxRatio);
    expect(capacity[12].trueCapacity_Wh).toBe(2000);
    expect(capacity[12].maxProduction_Wh).toBe(1000);
    expect(capacity[12].maxRatio).toBe(0.5);
  });

  it('falls back to maxProd when ratio <= 0.1', () => {
    const maxProd = new Array(24).fill(0);
    const maxRatio = new Array(24).fill(0);
    maxProd[8] = 300;
    maxRatio[8] = 0.05;

    const capacity = estimateHourlyCapacity(maxProd, maxRatio);
    expect(capacity[8].trueCapacity_Wh).toBe(300);
  });

  it('returns 0 capacity when both are 0', () => {
    const maxProd = new Array(24).fill(0);
    const maxRatio = new Array(24).fill(0);

    const capacity = estimateHourlyCapacity(maxProd, maxRatio);
    expect(capacity[0].trueCapacity_Wh).toBe(0);
  });

  it('returns length 24 array', () => {
    const capacity = estimateHourlyCapacity(new Array(24).fill(0), new Array(24).fill(0));
    expect(capacity).toHaveLength(24);
    capacity.forEach((c, i) => expect(c.hour).toBe(i));
  });
});

// ---------------------------------------------------------------------------
// forecastPv
// ---------------------------------------------------------------------------

describe('forecastPv', () => {
  it('computes prediction from capacity and forecast irradiance', () => {
    const capacity = new Array(24).fill(null).map((_, h) => ({
      hour: h,
      maxProduction_Wh: 0,
      maxRatio: 0,
      trueCapacity_Wh: h === 12 ? 2000 : 0,
    }));

    // A forecast record for hour 12 with moderate GHI
    const forecastIrradiance = [
      { time: Date.UTC(2024, 5, 20, 12), hour: 12, ghi_W_per_m2: 500, intervalMinutes: 60 },
    ];

    const points = forecastPv(capacity, forecastIrradiance, 51.05, 3.71);
    expect(points).toHaveLength(1);
    expect(points[0].predicted).toBeGreaterThan(0);
    expect(points[0].hour).toBe(12);
    expect(points[0].ghiForecast_W_per_m2).toBe(500);
  });

  it('looks up actuals from map', () => {
    const capacity = new Array(24).fill(null).map((_, h) => ({
      hour: h,
      maxProduction_Wh: 0,
      maxRatio: 0,
      trueCapacity_Wh: 1000,
    }));

    const ts = Date.UTC(2024, 5, 20, 12);
    const forecastIrradiance = [
      { time: ts, hour: 12, ghi_W_per_m2: 500, intervalMinutes: 60 },
    ];

    const actuals = new Map([[ts, 800]]);
    const points = forecastPv(capacity, forecastIrradiance, 51.05, 3.71, actuals);
    expect(points[0].actual).toBe(800);
  });

  it('returns null actual when not in map', () => {
    const capacity = new Array(24).fill(null).map((_, h) => ({
      hour: h,
      maxProduction_Wh: 0,
      maxRatio: 0,
      trueCapacity_Wh: 0,
    }));

    const forecastIrradiance = [
      { time: Date.UTC(2024, 5, 20, 12), hour: 12, ghi_W_per_m2: 0, intervalMinutes: 60 },
    ];

    const points = forecastPv(capacity, forecastIrradiance, 51.05, 3.71);
    expect(points[0].actual).toBeNull();
  });

  it('clamps prediction to 0 minimum', () => {
    const capacity = new Array(24).fill(null).map((_, h) => ({
      hour: h,
      maxProduction_Wh: 0,
      maxRatio: 0,
      trueCapacity_Wh: 0,
    }));

    const forecastIrradiance = [
      { time: Date.UTC(2024, 5, 20, 2), hour: 2, ghi_W_per_m2: 0, intervalMinutes: 60 },
    ];

    const points = forecastPv(capacity, forecastIrradiance, 51.05, 3.71);
    expect(points[0].predicted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildPvForecastSeries
// ---------------------------------------------------------------------------

describe('buildPvForecastSeries', () => {
  it('converts hourly points to 15-min slots', () => {
    const points = [
      { time: Date.UTC(2024, 5, 20, 10), hour: 10, ghiClear_W_per_m2: 0, ghiForecast_W_per_m2: 0, forecastRatio: 0, predicted: 1000, actual: null },
      { time: Date.UTC(2024, 5, 20, 11), hour: 11, ghiClear_W_per_m2: 0, ghiForecast_W_per_m2: 0, forecastRatio: 0, predicted: 2000, actual: null },
    ];

    const start = new Date(Date.UTC(2024, 5, 20, 10)).toISOString();
    const end = new Date(Date.UTC(2024, 5, 20, 12)).toISOString();

    const mapped = points.map(p => ({ time: p.time, value: p.predicted }));
    const series = buildForecastSeries(mapped, start, end);
    expect(series.step).toBe(15);
    expect(series.values).toHaveLength(8); // 2 hours × 4 slots

    // First 4 slots should all be 1000 W (from 1000 Wh hour)
    expect(series.values[0]).toBe(1000);
    expect(series.values[3]).toBe(1000);
    // Next 4 slots should all be 2000 W
    expect(series.values[4]).toBe(2000);
    expect(series.values[7]).toBe(2000);
  });

  it('returns 0 for hours without forecast points', () => {
    const points = [];
    const start = new Date(Date.UTC(2024, 5, 20, 10)).toISOString();
    const end = new Date(Date.UTC(2024, 5, 20, 11)).toISOString();

    const mapped = points.map(p => ({ time: p.time, value: p.predicted }));
    const series = buildForecastSeries(mapped, start, end);
    expect(series.values).toHaveLength(4);
    expect(series.values.every(v => v === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validatePvForecast
// ---------------------------------------------------------------------------

describe('validatePvForecast', () => {
  it('returns zeros for empty input', () => {
    const metrics = validatePvForecast([]);
    expect(metrics.mae).toBe(0);
    expect(metrics.rmse).toBe(0);
    expect(metrics.n).toBe(0);
  });

  it('computes MAE and RMSE correctly', () => {
    const points = [
      { time: 0, hour: 10, ghiClear_W_per_m2: 0, ghiForecast_W_per_m2: 0, forecastRatio: 0, predicted: 100, actual: 80 },
      { time: 1, hour: 11, ghiClear_W_per_m2: 0, ghiForecast_W_per_m2: 0, forecastRatio: 0, predicted: 200, actual: 250 },
    ];

    const metrics = validatePvForecast(points);
    expect(metrics.n).toBe(2);
    // MAE = (|20| + |50|) / 2 = 35
    expect(metrics.mae).toBe(35);
    // RMSE = sqrt((400 + 2500) / 2) = sqrt(1450)
    expect(metrics.rmse).toBeCloseTo(Math.sqrt(1450), 5);
  });

  it('skips points where actual is null', () => {
    const points = [
      { time: 0, hour: 10, ghiClear_W_per_m2: 0, ghiForecast_W_per_m2: 0, forecastRatio: 0, predicted: 100, actual: 80 },
      { time: 1, hour: 11, ghiClear_W_per_m2: 0, ghiForecast_W_per_m2: 0, forecastRatio: 0, predicted: 200, actual: null },
    ];

    const metrics = validatePvForecast(points);
    expect(metrics.n).toBe(1);
    expect(metrics.mae).toBe(20);
  });
});
