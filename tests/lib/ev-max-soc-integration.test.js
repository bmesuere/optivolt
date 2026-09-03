import { describe, it, expect, beforeAll } from 'vitest';
// @ts-ignore — vendor build artifact has no types
import highsFactory from '../../vendor/highs-build/highs.js';
import { buildLP } from '../../lib/build-lp.ts';
import { parseSolution } from '../../lib/parse-solution.ts';

// End-to-end checks for the EV charge ceiling: it holds against opportunistic charging (a
// strong SoC valuation plus cheap power) but yields to an explicit target.

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
  evInitialSoc_percent: 50, // 30 000 Wh
  evChargeEfficiency_percent: 100,
  availabilityWindows: [{ startSlot: 0, endSlot: T, resetSoc_Wh: 30000 }],
  targets: [],
};

describe('EV max SoC end-to-end', () => {
  // Unconstrained, the valuation fills the car for the whole horizon: 30 000 + 8 × 920 = 37 360.
  const UNCAPPED_WH = 37360;

  it('fills the car to the horizon limit when no ceiling is set', () => {
    const cfg = { ...baseCfg, ev: { ...baseEv } };
    const rows = parseSolution(highs.solve(buildLP(cfg), {}), cfg, { startMs: 0, stepMin: 15 });
    expect(socWh(rows[T - 1])).toBeCloseTo(UNCAPPED_WH, 2);
  });

  it('stops opportunistic charging at the ceiling', () => {
    // 55% of 60 kWh = 33 000 Wh, below what the horizon allows.
    const cfg = { ...baseCfg, ev: { ...baseEv, evMaxSoc_percent: 55 } };
    const rows = parseSolution(highs.solve(buildLP(cfg), {}), cfg, { startMs: 0, stepMin: 15 });
    for (const r of rows) expect(socWh(r)).toBeLessThanOrEqual(33000 + 1e-6);
    expect(socWh(rows[T - 1])).toBeCloseTo(33000, 2);
  });

  it('charges past the ceiling to meet an explicit target', () => {
    // No valuation, so nothing but the 60% (36 000 Wh) target pushes past the 55% ceiling.
    const cfg = {
      ...baseCfg,
      evSocValue_cents_per_kWh: 0,
      ev: { ...baseEv, evMaxSoc_percent: 55, targets: [{ slot: T - 1, soc_Wh: 36000 }] },
    };
    const rows = parseSolution(highs.solve(buildLP(cfg), {}), cfg, { startMs: 0, stepMin: 15 });
    expect(socWh(rows[T - 1])).toBeCloseTo(36000, 2);
  });

  it('keeps a car that arrives above the ceiling feasible without charging it further', () => {
    const cfg = {
      ...baseCfg,
      ev: {
        ...baseEv,
        evMaxSoc_percent: 55,
        evInitialSoc_percent: 80, // 48 000 Wh, already past the ceiling
        availabilityWindows: [{ startSlot: 0, endSlot: T, resetSoc_Wh: 48000 }],
      },
    };
    const rows = parseSolution(highs.solve(buildLP(cfg), {}), cfg, { startMs: 0, stepMin: 15 });
    for (const r of rows) expect(socWh(r)).toBeCloseTo(48000, 2);
  });
});
