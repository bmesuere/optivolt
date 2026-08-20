import { describe, it, expect } from 'vitest';
import {
  buildTimeline15Min,
  ensureWindow,
  parseDessSettings,
  parseForecastsResponse,
  parsePricesResponse,
  windowOptimizationHorizon,
} from '../../lib/vrm-payloads.ts';

// Times are interpreted in local time (TZ pinned in vitest.config.js).
describe('windowOptimizationHorizon', () => {
  it('starts at the last full local hour', () => {
    const now = new Date(2024, 0, 1, 10, 37, 12, 500);
    const win = windowOptimizationHorizon(0, now.getTime());
    expect(win.startMs).toBe(new Date(2024, 0, 1, 10, 0, 0).getTime());
    expect(win.startSec).toBe(win.startMs / 1000);
  });

  it('ends at midnight tonight before 13:00 and midnight tomorrow after', () => {
    const before = windowOptimizationHorizon(0, new Date(2024, 0, 1, 12, 59).getTime());
    const after = windowOptimizationHorizon(0, new Date(2024, 0, 1, 13, 0).getTime());
    expect(before.endMs).toBe(new Date(2024, 0, 2, 0, 0, 0).getTime());
    expect(after.endMs).toBe(new Date(2024, 0, 3, 0, 0, 0).getTime());
  });

  it('pushes the end out by extraDays', () => {
    const win = windowOptimizationHorizon(2, new Date(2024, 0, 1, 10, 0).getTime());
    expect(win.endMs).toBe(new Date(2024, 0, 4, 0, 0, 0).getTime());
    expect(win.endSec).toBe(win.endMs / 1000);
  });
});

describe('ensureWindow', () => {
  it('derives seconds from an explicit ms window', () => {
    const win = ensureWindow({ startMs: 1_700_000_500, endMs: 1_700_003_900 });
    expect(win).toEqual({ startMs: 1_700_000_500, endMs: 1_700_003_900, startSec: 1_700_000, endSec: 1_700_003 });
  });

  it('derives ms from an explicit seconds window', () => {
    const win = ensureWindow({ startSec: 1000, endSec: 2000 });
    expect(win).toEqual({ startSec: 1000, endSec: 2000, startMs: 1_000_000, endMs: 2_000_000 });
  });

  it('falls back to the standard horizon when nothing is given', () => {
    const nowMs = new Date(2024, 0, 1, 10, 30).getTime();
    expect(ensureWindow({}, nowMs)).toEqual(windowOptimizationHorizon(0, nowMs));
  });
});

describe('buildTimeline15Min', () => {
  it('covers [start, end) in 15-minute steps', () => {
    const start = Date.UTC(2024, 0, 1, 0, 0);
    const timeline = buildTimeline15Min(start, start + 3_600_000);
    expect(timeline).toEqual([start, start + 900_000, start + 1_800_000, start + 2_700_000]);
  });
});

describe('parseDessSettings', () => {
  const payload = {
    success: true,
    data: {
      idSite: 42,
      gridSell: 1,
      batteryCapacity: 10,
      dischargePower: 5,
      chargePower: 4,
      maxPowerFromGrid: 9.2,
      maxPowerToGrid: 5,
      batteryCosts: 0.05,
      gridExportLimit: 3,
      gridImportLimit: 0,
      batteryChargeLimit: 2.5,
      batteryDischargeLimit: 0,
      isOn: true,
      isGreenModeOn: '1',
      isPeriodicFullChargeOn: 0,
      alwaysApplyBatteryFlowRestriction: false,
      updatedOn: '2024-01-01T00:00:00Z',
    },
  };

  it('converts kW/kWh/€ to W/Wh and cents', () => {
    const s = parseDessSettings(payload);
    expect(s.batteryCapacity_kWh).toBe(10);
    expect(s.batteryCapacity_Wh).toBe(10000);
    expect(s.dischargePower_W).toBe(5000);
    expect(s.chargePower_W).toBe(4000);
    expect(s.maxPowerFromGrid_W).toBe(9200);
    expect(s.batteryCosts_eur_per_kWh).toBe(0.05);
    expect(s.batteryCosts_cents_per_kWh).toBeCloseTo(5);
  });

  it('reads 1 / "1" / true as flags and nulls zero limits', () => {
    const s = parseDessSettings(payload);
    expect(s.gridSell).toBe(true);
    expect(s.flags).toEqual({
      isOn: true,
      isGreenModeOn: true,
      isPeriodicFullChargeOn: false,
      alwaysApplyBatteryFlowRestriction: false,
    });
    expect(s.limits).toEqual({
      gridExportLimit_W: 3000,
      gridImportLimit_W: null,
      batteryChargeLimit_W: 2500,
      batteryDischargeLimit_W: null,
    });
    expect(s.createdOn).toBeNull();
  });

  it('treats non-numeric values as 0', () => {
    const s = parseDessSettings({ success: true, data: { batteryCapacity: 'nope' } });
    expect(s.batteryCapacity_kWh).toBe(0);
    expect(s.batteryCapacity_Wh).toBe(0);
  });

  it('throws when the API reports failure', () => {
    expect(() => parseDessSettings({ success: false })).toThrow('dynamic-ess-settings: success=false');
    expect(() => parseDessSettings(null)).toThrow('dynamic-ess-settings: success=false');
  });
});

describe('parseForecastsResponse', () => {
  const H = 3_600_000;
  const startMs = Date.UTC(2026, 0, 15, 0, 0, 0);
  const win = { startMs, endMs: startMs + 2 * H, startSec: startMs / 1000, endSec: (startMs + 2 * H) / 1000 };

  it('spreads each hourly W value across its four quarter-hours', () => {
    const forecasts = parseForecastsResponse({
      success: true,
      records: {
        vrm_consumption_fc: [[startMs, 400], [startMs + H, 500]],
        solar_yield_forecast: [[startMs + H, 200]],
      },
    }, win);

    expect(forecasts.step_minutes).toBe(15);
    expect(forecasts.load_W).toEqual([400, 400, 400, 400, 500, 500, 500, 500]);
    expect(forecasts.pv_W).toEqual([0, 0, 0, 0, 200, 200, 200, 200]);
    expect(forecasts.timestamps_iso[0]).toBe(new Date(startMs).toISOString());
  });

  it('zero-fills hours without data and ignores non-positive values', () => {
    const forecasts = parseForecastsResponse({
      success: true,
      records: { vrm_consumption_fc: [[startMs, -100]] },
    }, win);
    expect(forecasts.load_W).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('clamps the timeline to load coverage, not a longer PV series', () => {
    const forecasts = parseForecastsResponse({
      success: true,
      records: {
        vrm_consumption_fc: [[startMs, 400]],
        solar_yield_forecast: [[startMs, 100], [startMs + H, 200]],
      },
    }, win, { clampEndToData: true });

    expect(forecasts.timestamps).toHaveLength(4); // one hour of load coverage
  });

  it('yields an empty timeline when clamping and there is no load data', () => {
    const forecasts = parseForecastsResponse({
      success: true,
      records: { solar_yield_forecast: [[startMs, 100]] },
    }, win, { clampEndToData: true });

    expect(forecasts.timestamps).toHaveLength(0);
    expect(forecasts.load_W).toHaveLength(0);
  });

  it('throws when the API reports failure', () => {
    expect(() => parseForecastsResponse({ success: false }, win)).toThrow('forecast stats: success=false');
  });
});

describe('parsePricesResponse', () => {
  const startMs = Date.UTC(2026, 0, 15, 0, 0, 0);
  const win = { startMs, endMs: startMs + 3_600_000, startSec: startMs / 1000, endSec: (startMs + 3_600_000) / 1000 };

  it('aligns 15-min prices and converts €/kWh to cents', () => {
    const prices = parsePricesResponse({
      success: true,
      records: {
        deGb: [[startMs, 0.25], [startMs + 900_000, 0.3]],
        deGs: [[startMs, 0.1]],
      },
    }, win);

    expect(prices.importPrice_eur_per_kwh).toEqual([0.25, 0.3, 0, 0]);
    expect(prices.importPrice_cents_per_kwh[0]).toBeCloseTo(25);
    expect(prices.exportPrice_cents_per_kwh[0]).toBeCloseTo(10);
    // Slots the feed doesn't cover stay at 0.
    expect(prices.exportPrice_eur_per_kwh).toEqual([0.1, 0, 0, 0]);
  });

  it('throws when the API reports failure', () => {
    expect(() => parsePricesResponse({ success: false }, win)).toThrow('prices stats: success=false');
  });
});
