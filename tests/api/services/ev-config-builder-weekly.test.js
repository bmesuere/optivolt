import { describe, it, expect } from 'vitest';
import { buildEvConfig } from '../../../api/services/ev-config-builder.ts';

// TZ=Europe/Amsterdam (vitest.config.js). 2026-10-12 is a Monday.
const local = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW_MS = local(2026, 10, 12, 12);
const STEP_MS = 15 * 60_000;
const slotOf = (ms) => Math.floor((ms - NOW_MS) / STEP_MS);
const T = 4 * 24 * 4; // four days of 15-min slots: Monday 12:00 → Friday 12:00

const base = {
  stepSize_m: 15,
  evEnabled: true,
  evMinChargeCurrent_A: 6,
  evMaxChargeCurrent_A: 16,
  evBatteryCapacity_kWh: 60,
  evChargeEfficiency_percent: 100,
  evTripSocBuffer_percent: 20,
  batteryCapacity_Wh: 20000,
  maxChargePower_W: 4000,
  maxGridImport_W: 10000,
  chargeEfficiency_percent: 100,
};
const WED = [{ weekdays: [3], start: '18:00', end: '07:00', soc_percent: 80 }];

describe('buildEvConfig — weekly schedule', () => {
  it('masks charging to the weekly window and pins its target at the window end', () => {
    const cfg = buildEvConfig({ ...base, evWeeklySchedule: WED }, [], { pluggedIn: true, soc_percent: 40 }, NOW_MS, T);
    const from = slotOf(local(2026, 10, 14, 18));
    const to = slotOf(local(2026, 10, 15, 7));

    expect(cfg.chargeAllowed).toHaveLength(T);
    expect(cfg.chargeAllowed.findIndex(Boolean)).toBe(from);
    expect(cfg.chargeAllowed.lastIndexOf(true)).toBe(to - 1);
    expect(cfg.chargeAllowed.filter(Boolean)).toHaveLength(to - from);

    // Plugged in now: one window from now until the window end (the future arrival is a no-op).
    expect(cfg.availabilityWindows).toEqual([{ startSlot: 0, endSlot: to, resetSoc_Wh: 24000 }]);
    expect(cfg.targets).toEqual([{ slot: to - 1, soc_Wh: 48000 }]);
  });

  it('models a car that is away now as arriving at the window start', () => {
    const cfg = buildEvConfig({ ...base, evWeeklySchedule: WED }, [], { pluggedIn: false, soc_percent: 30 }, NOW_MS, T);
    const from = slotOf(local(2026, 10, 14, 18));
    const to = slotOf(local(2026, 10, 15, 7));
    expect(cfg.availabilityWindows).toEqual([{ startSlot: from, endSlot: to, resetSoc_Wh: 18000 }]);
    expect(cfg.targets).toEqual([{ slot: to - 1, soc_Wh: 48000 }]);
  });

  it('clamps the target to what the masked slots can deliver', () => {
    // A one-hour window at 3.68 kW delivers at most 3 680 Wh on top of the 24 000 Wh start.
    const short = [{ weekdays: [3], start: '18:00', end: '19:00', soc_percent: 100 }];
    const cfg = buildEvConfig({ ...base, evWeeklySchedule: short }, [], { pluggedIn: true, soc_percent: 40 }, NOW_MS, T);
    expect(cfg.targets[0].soc_Wh).toBeCloseTo(24000 + 4 * 3680 * 0.25, 6);
  });

  it('charges weekly plans from the cheapest source when switched on, with a home battery target before the window', () => {
    const state = { pluggedIn: true, soc_percent: 40 };
    const plan = [{ ...WED[0], ess_soc_percent: 90 }];
    const settings = { ...base, batteryCapacity_Wh: 10000, evWeeklySchedule: plan, evWeeklyCheapestSource: true };
    const cfg = buildEvConfig(settings, [], state, NOW_MS, T);
    expect(cfg.cheapestSource).toBe(true);
    expect(cfg.essTargets).toEqual([{ slot: slotOf(local(2026, 10, 14, 18)) - 1, soc_Wh: 9000 }]);
    // Switched off, or without weekly plans: deadline-driven as before.
    expect(buildEvConfig({ ...settings, evWeeklyCheapestSource: false }, [], state, NOW_MS, T).cheapestSource).toBeUndefined();
    expect(buildEvConfig({ ...base, evWeeklyCheapestSource: true }, [], state, NOW_MS, T).cheapestSource).toBeUndefined();
  });

  it('keeps deadline charging when the user entered a deadline', () => {
    const state = { pluggedIn: true, soc_percent: 40 };
    const departure = {
      id: 'manual-1', type: 'departure', time: new Date(local(2026, 10, 15, 6)).toISOString(), soc_percent: 90,
      createdAt: '', updatedAt: '',
    };
    expect(buildEvConfig({ ...base, evWeeklySchedule: WED, evWeeklyCheapestSource: true }, [departure], state, NOW_MS, T).cheapestSource).toBeUndefined();
  });

  it('ignores a plan without any weekday selected', () => {
    const inactive = [{ weekdays: [], start: '18:00', end: '07:00', soc_percent: 80 }];
    const cfg = buildEvConfig({ ...base, evWeeklySchedule: inactive }, [], { pluggedIn: true, soc_percent: 40 }, NOW_MS, T);
    expect(cfg.chargeAllowed).toBeUndefined();
    expect(cfg.targets).toEqual([]);
  });

  it('omits the mask without a weekly schedule', () => {
    const cfg = buildEvConfig(base, [], { pluggedIn: true, soc_percent: 40 }, NOW_MS, T);
    expect(cfg.chargeAllowed).toBeUndefined();
    expect(cfg.essSocFloor_Wh).toBeUndefined();
  });
});

describe('buildEvConfig — ESS floor', () => {
  it('passes the floor through in Wh', () => {
    const cfg = buildEvConfig({ ...base, evEssSocFloor_percent: 30 }, [], { pluggedIn: true, soc_percent: 40 }, NOW_MS, T);
    expect(cfg.essSocFloor_Wh).toBe(6000);
  });

  it('does not count slots before the battery could be refilled to the floor when sizing a target', () => {
    // Battery at 10% of 20 kWh, floor 30% → 4 000 Wh deficit at 4 kW = 4 slots of PV-only charging.
    const departure = { id: 'd', type: 'departure', time: new Date(NOW_MS + 8 * STEP_MS).toISOString(), soc_percent: 100, createdAt: '', updatedAt: '' };
    const withFloor = buildEvConfig({ ...base, evEssSocFloor_percent: 30 }, [departure], { pluggedIn: true, soc_percent: 40 }, NOW_MS, T, { essSoc_percent: 10 });
    const noFloor = buildEvConfig(base, [departure], { pluggedIn: true, soc_percent: 40 }, NOW_MS, T, { essSoc_percent: 10 });
    expect(noFloor.targets[0].soc_Wh).toBeCloseTo(24000 + 8 * 920, 6);
    expect(withFloor.targets[0].soc_Wh).toBeCloseTo(24000 + 4 * 920, 6);
  });
});
