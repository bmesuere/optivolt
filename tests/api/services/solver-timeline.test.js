import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildSolverConfigFromSettings } from '../../../api/services/config-builder.ts';

/**
 * These tests verify the "Smart Reader" logic in config-builder.js.
 *
 * They verify that:
 * 1. The solver horizon starts at the current 15-minute slot (now).
 * 2. The solver horizon ends based on the SHORTEST available data stream.
 *    (We no longer slice data during writing; we slice during reading).
 *
 * This ensures that if we have 24h of Load/PV but only 12h of Prices,
 * the solver only runs for 12h to avoid guessing prices.
 */
describe('Solver Timeline Logic (Refactored)', () => {
  const mockSettings = {
    stepSize_m: 15,
    batteryCapacity_Wh: 10000,
    minSoc_percent: 10,
    maxSoc_percent: 90,
    maxChargePower_W: 1000,
    maxDischargePower_W: 1000,
    maxGridImport_W: 2000,
    maxGridExport_W: 2000,
    chargeEfficiency_percent: 95,
    dischargeEfficiency_percent: 95,
    batteryCost_cent_per_kWh: 0,
    idleDrain_W: 0,
    terminalSocValuation: 'zero'
  };

  // Mock Date to a fixed "Now"
  const NOW_STRING = '2024-01-01T12:05:00Z'; // 12:05


  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_STRING));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calculates start time as the beginning of the current 15-minute slot', async () => {
    // Current valid data structure (will be updated in refactor)
    // The test assumes the NEW structure.
    const mockData = {
      load: { start: '2024-01-01T10:00:00Z', step: 15, values: Array(100).fill(100) },
      pv: { start: '2024-01-01T10:00:00Z', step: 15, values: Array(100).fill(0) },
      importPrice: { start: '2024-01-01T10:00:00Z', step: 15, values: Array(100).fill(10) },
      exportPrice: { start: '2024-01-01T10:00:00Z', step: 15, values: Array(100).fill(5) },
      soc: { timestamp: '2024-01-01T12:00:00Z', value: 50 }
    };

    // Case 1: Data limits the horizon (25h total, starting 2h before now -> 23h remaining)
    // 23 hours * 4 slots = 92 slots
    const config = buildSolverConfigFromSettings(mockSettings, mockData);
    expect(config.load_W.length).toBe(92);
    expect(config.pv_W.length).toBe(92);

    // Case 2: Sufficient data for full 24h
    // We need data ending at least 24h after NOW (12:00). So end >= 12:00 tomorrow.
    // Start 10:00 today. Duration needed: 2h (to get to 12:00) + 24h = 26h.
    // 26h * 4 = 104 slots.
    const longData = {
      load: { ...mockData.load, values: Array(104).fill(100) },
      pv: { ...mockData.pv, values: Array(104).fill(0) },
      importPrice: { ...mockData.importPrice, values: Array(104).fill(10) },
      exportPrice: { ...mockData.exportPrice, values: Array(104).fill(5) },
      soc: mockData.soc
    };

    const configFull = buildSolverConfigFromSettings(mockSettings, longData);
    expect(configFull.load_W.length).toBe(96); // 24h * 4
  });

  it('rejects load and price series that start after the plan window begins', () => {
    const baseData = {
      load: { start: '2024-01-01T10:00:00Z', step: 15, values: Array(100).fill(100) },
      pv: { start: '2024-01-01T10:00:00Z', step: 15, values: Array(100).fill(0) },
      importPrice: { start: '2024-01-01T10:00:00Z', step: 15, values: Array(100).fill(10) },
      exportPrice: { start: '2024-01-01T10:00:00Z', step: 15, values: Array(100).fill(5) },
      soc: { timestamp: '2024-01-01T12:00:00Z', value: 50 }
    };

    // extractWindow would zero-pad the leading slots of these series, which
    // for load/prices means planning against free energy.
    for (const key of ['load', 'importPrice', 'exportPrice']) {
      const data = {
        ...baseData,
        [key]: { ...baseData[key], start: '2024-01-01T12:30:00Z' }, // after now (12:00)
      };
      expect(() => buildSolverConfigFromSettings(mockSettings, data))
        .toThrowError(new RegExp(`'${key}' starts after`));
    }

    // A series starting exactly at the window start is fine.
    const exactStart = {
      ...baseData,
      importPrice: { ...baseData.importPrice, start: '2024-01-01T12:00:00Z' },
    };
    expect(() => buildSolverConfigFromSettings(mockSettings, exactStart)).not.toThrow();
  });

  it('extends prices with the forecast tail when the extended horizon is enabled', () => {
    // Actual prices end at 14:00; load/pv run much longer.
    const data = {
      load: { start: '2024-01-01T10:00:00Z', step: 15, values: Array(100).fill(100) },
      pv: { start: '2024-01-01T10:00:00Z', step: 15, values: Array(100).fill(0) },
      importPrice: { start: '2024-01-01T10:00:00Z', step: 15, values: Array(16).fill(10) },
      exportPrice: { start: '2024-01-01T10:00:00Z', step: 15, values: Array(16).fill(5) },
      importPriceForecast: { start: '2024-01-01T13:00:00Z', step: 15, values: Array(40).fill(20) },
      exportPriceForecast: { start: '2024-01-01T13:00:00Z', step: 15, values: Array(40).fill(15) },
      soc: { timestamp: '2024-01-01T12:00:00Z', value: 50 }
    };

    // Without the setting: forecast ignored, horizon ends at 14:00 (8 slots from 12:00).
    const base = buildSolverConfigFromSettings(mockSettings, data);
    expect(base.importPrice.length).toBe(8);
    expect(base.pricesKnownUntilMs).toBeUndefined();

    // With the setting: horizon runs to the forecast end (13:00 + 40×15min = 23:00 → 44 slots from 12:00),
    // actual values win up to 14:00, forecast values fill the tail.
    const extended = buildSolverConfigFromSettings({ ...mockSettings, extendedHorizonDays: 2 }, data);
    expect(extended.importPrice.length).toBe(44);
    expect(extended.importPrice.slice(0, 8).every(v => v === 10)).toBe(true);
    expect(extended.importPrice.slice(8).every(v => v === 20)).toBe(true);
    expect(extended.exportPrice.slice(8).every(v => v === 15)).toBe(true);
    expect(extended.pricesKnownUntilMs).toBe(new Date('2024-01-01T14:00:00Z').getTime());
  });

  it('caps rebalance window starts to day 1 only on the extended horizon', () => {
    const data = {
      load: { start: '2024-01-01T10:00:00Z', step: 15, values: Array(100).fill(100) },
      pv: { start: '2024-01-01T10:00:00Z', step: 15, values: Array(100).fill(0) },
      importPrice: { start: '2024-01-01T10:00:00Z', step: 15, values: Array(100).fill(10) },
      exportPrice: { start: '2024-01-01T10:00:00Z', step: 15, values: Array(100).fill(5) },
      soc: { timestamp: '2024-01-01T12:00:00Z', value: 50 }
    };
    const rebalanceSettings = { ...mockSettings, rebalanceEnabled: true, rebalanceHoldHours: 3 };

    const standard = buildSolverConfigFromSettings(rebalanceSettings, data);
    expect(standard.rebalanceMaxStartSlot).toBeUndefined();

    const extended = buildSolverConfigFromSettings({ ...rebalanceSettings, extendedHorizonDays: 2 }, data);
    expect(extended.rebalanceMaxStartSlot).toBe(95); // 24 h of 15-min slots, 0-indexed
  });

  it('ignores a forecast that leaves a gap after the actual prices', () => {
    const data = {
      load: { start: '2024-01-01T10:00:00Z', step: 15, values: Array(100).fill(100) },
      pv: { start: '2024-01-01T10:00:00Z', step: 15, values: Array(100).fill(0) },
      importPrice: { start: '2024-01-01T10:00:00Z', step: 15, values: Array(16).fill(10) },
      exportPrice: { start: '2024-01-01T10:00:00Z', step: 15, values: Array(16).fill(5) },
      // Starts 15:00, actual ends 14:00 → gap → must be ignored, not zero-filled.
      importPriceForecast: { start: '2024-01-01T15:00:00Z', step: 15, values: Array(40).fill(20) },
      exportPriceForecast: { start: '2024-01-01T15:00:00Z', step: 15, values: Array(40).fill(15) },
      soc: { timestamp: '2024-01-01T12:00:00Z', value: 50 }
    };

    const config = buildSolverConfigFromSettings({ ...mockSettings, extendedHorizonDays: 2 }, data);
    expect(config.importPrice.length).toBe(8);
    expect(config.pricesKnownUntilMs).toBeUndefined();
  });

  it('allows a PV series that starts after the plan window begins (leading zeros = no sun)', () => {
    const data = {
      load: { start: '2024-01-01T10:00:00Z', step: 15, values: Array(100).fill(100) },
      pv: { start: '2024-01-01T14:00:00Z', step: 15, values: Array(84).fill(500) },
      importPrice: { start: '2024-01-01T10:00:00Z', step: 15, values: Array(100).fill(10) },
      exportPrice: { start: '2024-01-01T10:00:00Z', step: 15, values: Array(100).fill(5) },
      soc: { timestamp: '2024-01-01T12:00:00Z', value: 50 }
    };

    const config = buildSolverConfigFromSettings(mockSettings, data);
    // Slots between 12:00 and 14:00 are zero-padded PV.
    expect(config.pv_W.slice(0, 8).every(v => v === 0)).toBe(true);
    expect(config.pv_W[8]).toBe(500);
  });
});
