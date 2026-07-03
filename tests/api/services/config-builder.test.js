import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildSolverConfigFromSettings } from '../../../api/services/config-builder.ts';

const NOW_STRING = '2024-01-01T12:00:00Z';
const NOW_MS = new Date(NOW_STRING).getTime();

const mockSettings = {
  stepSize_m: 15,
  batteryCapacity_Wh: 10000,
  minSoc_percent: 20,
  maxSoc_percent: 100,
  maxChargePower_W: 1000,
  maxDischargePower_W: 1000,
  maxGridImport_W: 2000,
  maxGridExport_W: 2000,
  chargeEfficiency_percent: 95,
  dischargeEfficiency_percent: 95,
  batteryCost_cent_per_kWh: 0,
  idleDrain_W: 0,
  terminalSocValuation: 'zero',
  terminalSocCustomPrice_cents_per_kWh: 0,
  dataSources: { load: 'vrm', pv: 'vrm', prices: 'vrm', soc: 'mqtt' },
  dessAlgorithm: 'v1',
  rebalanceEnabled: false,
  rebalanceHoldHours: 3,
};

// 96 slots of data starting at NOW so there's always sufficient future data
const makeData = (rebalanceState = undefined) => ({
  load: { start: NOW_STRING, step: 15, values: Array(96).fill(100) },
  pv: { start: NOW_STRING, step: 15, values: Array(96).fill(0) },
  importPrice: { start: NOW_STRING, step: 15, values: Array(96).fill(10) },
  exportPrice: { start: NOW_STRING, step: 15, values: Array(96).fill(5) },
  soc: { timestamp: NOW_STRING, value: 50 },
  rebalanceState,
});

describe('buildSolverConfigFromSettings — rebalancing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_STRING));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not include rebalance fields when rebalanceEnabled is false', () => {
    const cfg = buildSolverConfigFromSettings(mockSettings, makeData(), NOW_MS);
    expect(cfg.rebalanceHoldSlots).toBeUndefined();
    expect(cfg.rebalanceRemainingSlots).toBeUndefined();
    expect(cfg.rebalanceTargetSoc_percent).toBeUndefined();
  });

  it('sets rebalanceRemainingSlots = holdSlots when startMs is null (not started)', () => {
    const settings = { ...mockSettings, rebalanceEnabled: true, rebalanceHoldHours: 3 };
    // 3h / (15min / 60) = 3 / 0.25 = 12 slots
    const cfg = buildSolverConfigFromSettings(settings, makeData({ startMs: null }), NOW_MS);
    expect(cfg.rebalanceHoldSlots).toBe(12);
    expect(cfg.rebalanceRemainingSlots).toBe(12);
    expect(cfg.rebalanceTargetSoc_percent).toBe(100);
  });

  it('counts down correctly when startMs is set (mid-cycle)', () => {
    const settings = { ...mockSettings, rebalanceEnabled: true, rebalanceHoldHours: 3 };
    // 2 slots elapsed (30 min ago): remaining = 12 - 2 = 10
    const startMs = NOW_MS - 2 * 15 * 60_000;
    const cfg = buildSolverConfigFromSettings(settings, makeData({ startMs }), NOW_MS);
    expect(cfg.rebalanceHoldSlots).toBe(12);
    expect(cfg.rebalanceRemainingSlots).toBe(10);
  });

  it('returns rebalanceRemainingSlots = 0 when cycle is complete', () => {
    const settings = { ...mockSettings, rebalanceEnabled: true, rebalanceHoldHours: 3 };
    // Started 12 slots (3h) ago — cycle is done
    const startMs = NOW_MS - 12 * 15 * 60_000;
    const cfg = buildSolverConfigFromSettings(settings, makeData({ startMs }), NOW_MS);
    expect(cfg.rebalanceRemainingSlots).toBe(0);
  });

  it('uses Math.ceil so the hold is never shorter than requested (fractional hours)', () => {
    // 1.1h / 0.25h = 4.4 → ceil → 5 slots (not round-down 4)
    const settings = { ...mockSettings, rebalanceEnabled: true, rebalanceHoldHours: 1.1 };
    const cfg = buildSolverConfigFromSettings(settings, makeData({ startMs: null }), NOW_MS);
    expect(cfg.rebalanceHoldSlots).toBe(5); // ceil(4.4) = 5
    expect(cfg.rebalanceRemainingSlots).toBe(5);
  });

  it('clamps holdSlots to at least 1 when rebalanceHoldHours is 0', () => {
    const settings = { ...mockSettings, rebalanceEnabled: true, rebalanceHoldHours: 0 };
    const cfg = buildSolverConfigFromSettings(settings, makeData({ startMs: null }), NOW_MS);
    expect(cfg.rebalanceHoldSlots).toBeGreaterThanOrEqual(1);
    expect(cfg.rebalanceRemainingSlots).toBeGreaterThanOrEqual(1);
  });
});

// EV config (static fields only); schedule comes from data.evScheduleEntries.
// Detailed EvConfig coverage lives in ev-config-builder.test.js; these are wiring checks.
const evSettings = {
  ...mockSettings,
  evEnabled: true,
  evMinChargeCurrent_A: 6,
  evMaxChargeCurrent_A: 16,
  evBatteryCapacity_kWh: 60,
  evChargeEfficiency_percent: 100,
};

const evEntry = (over = {}) => ({
  id: 'e1', type: 'departure', time: '2024-01-01T14:00:00Z', // 2 h after NOW → 8 slots
  createdAt: NOW_STRING, updatedAt: NOW_STRING, ...over,
});
const dataWithEntries = (entries) => ({ ...makeData(), evScheduleEntries: entries });

describe('buildSolverConfigFromSettings — EV config (wiring)', () => {
  it('does not add ev when evEnabled is false', () => {
    const cfg = buildSolverConfigFromSettings(mockSettings, makeData(), NOW_MS);
    expect(cfg.ev).toBeUndefined();
  });

  it('does not add ev when the car is neither present nor expected', () => {
    const cfg = buildSolverConfigFromSettings(
      evSettings, makeData(), NOW_MS, { pluggedIn: false, soc_percent: 50 },
    );
    expect(cfg.ev).toBeUndefined();
  });

  it('wires buildEvConfig in from data.evScheduleEntries when plugged in', () => {
    const cfg = buildSolverConfigFromSettings(
      evSettings, dataWithEntries([evEntry({ soc_percent: 80 })]), NOW_MS, { pluggedIn: true, soc_percent: 50 },
    );
    expect(cfg.ev).toBeDefined();
    expect(cfg.ev.availabilityWindows).toEqual([{ startSlot: 0, endSlot: 8, resetSoc_Wh: 30000 }]);
    expect(cfg.ev.targets).toEqual([{ slot: 7, soc_Wh: 37360 }]);
  });

  it('passes evSocValue_cents_per_kWh through to the solver config', () => {
    const cfg = buildSolverConfigFromSettings(
      { ...evSettings, evSocValue_cents_per_kWh: 15 },
      dataWithEntries([evEntry()]), NOW_MS, { pluggedIn: true, soc_percent: 50 },
    );
    expect(cfg.evSocValue_cents_per_kWh).toBe(15);
  });
});
