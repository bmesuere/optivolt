import { describe, it, expect, beforeAll } from 'vitest';
// @ts-ignore — vendor build artifact has no types
import highsFactory from '../../vendor/highs-build/highs.js';
import { buildLP } from '../../lib/build-lp.ts';
import { parseSolution } from '../../lib/parse-solution.ts';

// End-to-end checks for the trip feature's core property: the post-trip SoC is the
// pre-departure SoC minus the trip usage — a *relative* drop, never a fixed arrival SoC.
// Fixing the arrival SoC up front would (a) misstate the return SoC when the car charges
// before leaving and (b) remove any incentive for the solver to charge before departure.

let highs;
beforeAll(async () => {
  highs = await highsFactory({});
});

const T = 8;
const CAP_WH = 60000;
const socWh = (row) => (row.ev_soc_percent / 100) * CAP_WH;

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

const baseEv = {
  evMinChargePower_W: 1380,
  evMaxChargePower_W: 3680,
  evBatteryCapacity_Wh: CAP_WH,
  evInitialSoc_percent: 50,
  evChargeEfficiency_percent: 100,
  targets: [],
};

describe('EV trip (drop window) end-to-end', () => {
  it('carries pre-departure charging through the trip: arrival SoC = departure SoC − usage', () => {
    const cfg = {
      ...baseCfg,
      ev: {
        ...baseEv,
        availabilityWindows: [
          { startSlot: 0, endSlot: 3, resetSoc_Wh: 30000 }, // plugged in now, leaves at slot 3
          { startSlot: 5, endSlot: T, drop_Wh: 6000 },      // returns at slot 5 having used 6 kWh
        ],
      },
    };
    const result = highs.solve(buildLP(cfg), {});
    const rows = parseSolution(result, cfg, { startMs: 0, stepMin: 15 });

    // The valuation (only the chain end is valued) still rewards charging before departure...
    expect(rows.slice(0, 3).some((r) => r.ev_charge > 0)).toBe(true);
    // ...the SoC is flat while away...
    expect(socWh(rows[4])).toBeCloseTo(socWh(rows[2]), 3);
    // ...and the return SoC is exactly the departure SoC minus the usage (plus slot-5 charging),
    // NOT a value fixed at plan time.
    const chargedAtReentry_Wh = rows[5].ev_charge * 0.25; // W × 15 min, efficiency 100%
    expect(socWh(rows[5])).toBeCloseTo(socWh(rows[2]) - 6000 + chargedAtReentry_Wh, 2);
    // With max-value charging the whole way: 30000 + 3×920 = 32760 at departure.
    expect(socWh(rows[2])).toBeCloseTo(32760, 2);
  });

  it('forces charging at least the trip usage before departure even without a SoC valuation', () => {
    // The car cannot spend energy it does not hold: the drop plus ev_soc >= 0 makes the solver
    // charge the shortfall before leaving, with no target and no valuation nudging it.
    const cfg = {
      ...baseCfg,
      evSocValue_cents_per_kWh: 0,
      ev: {
        ...baseEv,
        evInitialSoc_percent: 2, // 1 200 Wh on board
        availabilityWindows: [
          { startSlot: 0, endSlot: 4, resetSoc_Wh: 1200 },
          { startSlot: 6, endSlot: T, drop_Wh: 3000 }, // trip needs 3 000 Wh
        ],
      },
    };
    const result = highs.solve(buildLP(cfg), {});
    expect(result.Status).toBe('Optimal');
    const rows = parseSolution(result, cfg, { startMs: 0, stepMin: 15 });

    const chargedBeforeDeparture_Wh = rows.slice(0, 4).reduce((s, r) => s + r.ev_charge * 0.25, 0);
    expect(chargedBeforeDeparture_Wh).toBeGreaterThanOrEqual(1800 - 1e-3); // 3000 − 1200 on board
    expect(socWh(rows[6])).toBeGreaterThanOrEqual(-1e-3);
  });

  it('meets a post-trip target by pre-charging through the drop when needed', () => {
    // Target 28 000 Wh shortly after the return: without pre-departure charging the chain
    // maxes at 30000 − 6000 + 2×920 = 25 840, so the shortfall must be charged before the
    // trip and survive the 6 000 Wh drop. (In production the builder clamps targets to what
    // the chain can reach — 28 600 here — so this stays feasible by construction.)
    const cfg = {
      ...baseCfg,
      evSocValue_cents_per_kWh: 0,
      ev: {
        ...baseEv,
        availabilityWindows: [
          { startSlot: 0, endSlot: 3, resetSoc_Wh: 30000 },
          { startSlot: 5, endSlot: T, drop_Wh: 6000 },
        ],
        targets: [{ slot: 6, soc_Wh: 28000 }],
      },
    };
    const result = highs.solve(buildLP(cfg), {});
    expect(result.Status).toBe('Optimal');
    const rows = parseSolution(result, cfg, { startMs: 0, stepMin: 15 });

    expect(socWh(rows[6])).toBeGreaterThanOrEqual(28000 - 1e-2);
    expect(rows.slice(0, 3).some((r) => r.ev_charge > 0)).toBe(true);
  });
});
