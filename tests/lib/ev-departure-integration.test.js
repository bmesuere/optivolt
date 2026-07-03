import { describe, it, expect, beforeAll } from 'vitest';
// @ts-ignore — vendor build artifact has no types
import highsFactory from '../../vendor/highs-build/highs.js';
import { buildLP } from '../../lib/build-lp.ts';
import { parseSolution } from '../../lib/parse-solution.ts';

// End-to-end regression for the headline bug: the EV used to keep charging after departure
// because there was no force-off there. With availability bounded by the departure slot, the
// solver must leave the EV alone after it departs — even with a strong SoC valuation pulling
// it to charge whenever possible.

let highs;
beforeAll(async () => {
  highs = await highsFactory({});
});

const T = 8;
const baseCfg = {
  load_W: Array(T).fill(0),
  pv_W: Array(T).fill(0),
  importPrice: Array(T).fill(5),
  exportPrice: Array(T).fill(1),
  stepSize_m: 15,
  batteryCapacity_Wh: 10000,
  minSoc_percent: 10,
  maxSoc_percent: 100,
  maxChargePower_W: 5000,
  maxDischargePower_W: 5000,
  maxGridImport_W: 10000,
  maxGridExport_W: 10000,
  chargeEfficiency_percent: 100,
  dischargeEfficiency_percent: 100,
  batteryCost_cent_per_kWh: 0,
  idleDrain_W: 0,
  terminalSocValuation: 'zero',
  terminalSocCustomPrice_cents_per_kWh: 0,
  evSocValue_cents_per_kWh: 100, // strong incentive to fill the EV whenever it is allowed to
  initialSoc_percent: 50,
};

describe('EV charging stops at departure (end-to-end)', () => {
  it('never charges the EV after departure despite a strong SoC valuation', () => {
    const cfg = {
      ...baseCfg,
      ev: {
        evMinChargePower_W: 1380,
        evMaxChargePower_W: 3680,
        evBatteryCapacity_Wh: 60000,
        evInitialSoc_percent: 50,
        evChargeEfficiency_percent: 100,
        availabilityWindows: [{ startSlot: 0, endSlot: 3, resetSoc_Wh: 30000 }], // leaves at slot 3
        targets: [],
      },
    };
    const result = highs.solve(buildLP(cfg), {});
    const rows = parseSolution(result, cfg, { startMs: 0, stepMin: 15 });

    // It should charge before departure (valuation makes it worthwhile)...
    expect(rows.slice(0, 3).some((r) => r.ev_charge > 0)).toBe(true);
    // ...and never after.
    for (let t = 3; t < T; t++) {
      expect(rows[t].ev_charge).toBe(0);
    }
    // SoC is held flat from the departure slot onward.
    expect(rows[T - 1].ev_soc_percent).toBeCloseTo(rows[2].ev_soc_percent, 6);
  });

  it('keeps charging after an early target deadline when the car stays plugged in', () => {
    const cfg = {
      ...baseCfg,
      evSocValue_cents_per_kWh: 100,
      ev: {
        evMinChargePower_W: 1380,
        evMaxChargePower_W: 3680,
        evBatteryCapacity_Wh: 60000,
        evInitialSoc_percent: 50,
        evChargeEfficiency_percent: 100,
        availabilityWindows: [{ startSlot: 0, endSlot: T, resetSoc_Wh: 30000 }], // stays plugged in
        // Deadline reachable in 2 slots (max 920 Wh/slot from 30000 → 31840).
        targets: [{ slot: 1, soc_Wh: 31000 }],
      },
    };
    const result = highs.solve(buildLP(cfg), {});
    const rows = parseSolution(result, cfg, { startMs: 0, stepMin: 15 });

    // The deadline is met...
    expect(rows[1].ev_soc_percent).toBeGreaterThanOrEqual((31000 / 60000) * 100 - 1e-6);
    // ...and cheap charging continues afterwards (latent charging is not cut off at the deadline).
    expect(rows.slice(2).some((r) => r.ev_charge > 0)).toBe(true);
  });
});
