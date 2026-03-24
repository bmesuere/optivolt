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

// EV settings: 6–16 A @ 230 V, 60 kWh battery, 80% target
const evSettings = {
  ...mockSettings,
  evEnabled: true,
  evMinChargeCurrent_A: 6,
  evMaxChargeCurrent_A: 16,
  evBatteryCapacity_kWh: 60,
  evDepartureTime: '2024-01-01T14:00:00Z', // 2 h after NOW_MS → 8 slots @ 15 min
  evTargetSoc_percent: 80,
  evChargeEfficiency_percent: 100,
};

describe('buildSolverConfigFromSettings — EV config', () => {
  it('does not add ev when evEnabled is false', () => {
    const cfg = buildSolverConfigFromSettings(mockSettings, makeData(), NOW_MS);
    expect(cfg.ev).toBeUndefined();
  });

  it('does not add ev when evState is undefined', () => {
    const cfg = buildSolverConfigFromSettings(evSettings, makeData(), NOW_MS, undefined);
    expect(cfg.ev).toBeUndefined();
  });

  it('does not add ev when EV is not plugged in', () => {
    const cfg = buildSolverConfigFromSettings(
      evSettings, makeData(), NOW_MS, { pluggedIn: false, soc_percent: 50 },
    );
    expect(cfg.ev).toBeUndefined();
  });

  it('adds ev config when evEnabled and pluggedIn', () => {
    const cfg = buildSolverConfigFromSettings(
      evSettings, makeData(), NOW_MS, { pluggedIn: true, soc_percent: 50 },
    );
    expect(cfg.ev).toBeDefined();
    expect(cfg.ev.evMinChargePower_W).toBe(6 * 230);   // 1380
    expect(cfg.ev.evMaxChargePower_W).toBe(16 * 230);  // 3680
    expect(cfg.ev.evBatteryCapacity_Wh).toBe(60_000);
    expect(cfg.ev.evInitialSoc_percent).toBe(50);
    expect(cfg.ev.evDepartureSlot).toBe(8); // 2h / 15min = 8 slots
  });

  it('clamps achievable target when max charge falls short of requested target', () => {
    // 50% initial = 30 000 Wh, 8 slots × 3680 W × 0.25 h = 7 360 Wh reachable
    // achievable = min(48000, 37360, 60000) = 37360 → 62.267%
    const cfg = buildSolverConfigFromSettings(
      evSettings, makeData(), NOW_MS, { pluggedIn: true, soc_percent: 50 },
    );
    const expectedPct = (37360 / 60000) * 100;
    expect(cfg.ev.evTargetSoc_percent).toBeCloseTo(expectedPct, 3);
  });

  it('reduces achievable target by evChargeEfficiency_percent when clamping', () => {
    // 90% efficiency: 8 slots × 3680 W × 0.25 h × 0.9 = 6624 Wh reachable
    // achievable = min(48000, 30000 + 6624, 60000) = 36624 → 61.04%
    const cfg = buildSolverConfigFromSettings(
      { ...evSettings, evChargeEfficiency_percent: 90 },
      makeData(), NOW_MS, { pluggedIn: true, soc_percent: 50 },
    );
    const expectedPct = (36624 / 60000) * 100;
    expect(cfg.ev.evTargetSoc_percent).toBeCloseTo(expectedPct, 3);
  });

  it('passes evChargeEfficiency_percent through to EvConfig', () => {
    const cfg = buildSolverConfigFromSettings(
      { ...evSettings, evChargeEfficiency_percent: 85 },
      makeData(), NOW_MS, { pluggedIn: true, soc_percent: 50 },
    );
    expect(cfg.ev.evChargeEfficiency_percent).toBe(85);
  });

  it('does not add ev when departure is in the past (D=0)', () => {
    const pastDeparture = { ...evSettings, evDepartureTime: '2024-01-01T11:00:00Z' };
    const cfg = buildSolverConfigFromSettings(
      pastDeparture, makeData(), NOW_MS, { pluggedIn: true, soc_percent: 50 },
    );
    expect(cfg.ev).toBeUndefined();
  });

  it('does not add ev when departure string is not a valid date', () => {
    const badDeparture = { ...evSettings, evDepartureTime: '07:30' };
    const cfg = buildSolverConfigFromSettings(
      badDeparture, makeData(), NOW_MS, { pluggedIn: true, soc_percent: 50 },
    );
    expect(cfg.ev).toBeUndefined();
  });
});
