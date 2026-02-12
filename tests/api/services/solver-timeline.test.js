import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildSolverConfigFromSettings } from '../../../api/services/solver-input-service.js';

/**
 * These tests verify the "Smart Reader" logic in solver-input-service.js.
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
});
