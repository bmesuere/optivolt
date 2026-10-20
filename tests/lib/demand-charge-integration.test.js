import { describe, it, expect, beforeAll } from 'vitest';
// @ts-ignore — vendor build artifact has no types
import highsFactory from '../../vendor/highs-build/highs.js';
import { buildLP } from '../../lib/build-lp.ts';
import { parseSolution } from '../../lib/parse-solution.ts';
import { summarizeDemandCharge } from '../../lib/demand-charge.ts';

// End-to-end checks that the demand charge trades energy savings against the
// cost of raising a billing period's peak, the way a monthly peak tariff such
// as the Flemish capaciteitstarief does.

let highs;
beforeAll(async () => {
  highs = await highsFactory({});
});

const T = 8;

const baseCfg = {
  load_W: Array(T).fill(0),
  pv_W: Array(T).fill(0),
  importPrice: Array(T).fill(10),
  exportPrice: Array(T).fill(0),
  stepSize_m: 15,
  batteryCapacity_Wh: 10000,
  minSoc_percent: 0,
  maxSoc_percent: 100,
  maxChargePower_W: 5000,
  maxDischargePower_W: 5000,
  maxGridImport_W: 20000,
  maxGridExport_W: 0,
  chargeEfficiency_percent: 100,
  dischargeEfficiency_percent: 100,
  batteryCost_cent_per_kWh: 0,
  idleDrain_W: 0,
  terminalSocValuation: 'zero',
  terminalSocCustomPrice_cents_per_kWh: 0,
  evSocValue_cents_per_kWh: 0,
  initialSoc_percent: 0,
};

const solve = (cfg) => {
  const result = highs.solve(buildLP(cfg), {});
  expect(result.Status).toBe('Optimal');
  return parseSolution(result, cfg, { startMs: 0, stepMin: 15 });
};
const peak = (rows) => Math.max(...rows.map((r) => r.imp));

// Cheap first hour, expensive second hour with a 3 kW load: shifting all of it
// into the battery needs 3 kW of charging per cheap slot, i.e. a 3 kW peak.
const shiftCfg = {
  ...baseCfg,
  load_W: [0, 0, 0, 0, 3000, 3000, 3000, 3000],
  importPrice: [5, 5, 5, 5, 40, 40, 40, 40],
};
const oneMonth = (cost_cents_per_kW, threshold_W = 2500) => ({
  cost_cents_per_kW,
  periods: [{ startSlot: 0, endSlot: T, threshold_W }],
});

describe('demand charge end-to-end', () => {
  it('without a demand charge, shifts the whole load into the cheap hour at whatever peak', () => {
    const rows = solve(shiftCfg);
    expect(rows.slice(4).every((r) => r.imp < 1e-6)).toBe(true);
    // Any split of the 3 kWh over the cheap slots costs the same, so the solver is free to
    // pick a spiky one (in practice it charges at the 5 kW battery limit): at least 3 kW.
    expect(peak(rows)).toBeGreaterThanOrEqual(3000 - 1e-6);
  });

  it('keeps import at the free threshold when raising the peak costs more than it saves', () => {
    // Moving the last 0.5 kWh into the cheap hour saves 0.5 × 35 = 17.5 c€;
    // a 500 W higher peak at 100 €/kW costs 5000 c€.
    const cfg = { ...shiftCfg, demandCharge: oneMonth(10000) };
    const rows = solve(cfg);
    expect(peak(rows)).toBeCloseTo(2500, 3);
    // The rest of the expensive-hour load now comes from the grid, still under the threshold.
    const expensiveImport_Wh = rows.slice(4).reduce((s, r) => s + r.imp * 0.25, 0);
    expect(expensiveImport_Wh).toBeCloseTo(500, 3);
    expect(summarizeDemandCharge(rows, cfg.demandCharge)[0]).toMatchObject({ excess_W: 0, cost_cents: 0 });
  });

  it('raises the peak when the energy savings outweigh its cost', () => {
    // 1 c€/kW: the extra 500 W costs 0.5 c€ against 17.5 c€ saved.
    const cfg = { ...shiftCfg, demandCharge: oneMonth(1) };
    const rows = solve(cfg);
    expect(peak(rows)).toBeCloseTo(3000, 3);
    expect(summarizeDemandCharge(rows, cfg.demandCharge)[0]).toMatchObject({ plannedPeak_W: 3000, excess_W: 500, cost_cents: 0.5 });
  });

  it('treats a threshold already above the planned need as free', () => {
    // E.g. the month already hit 4.1 kW: shifting at 3 kW costs nothing extra.
    const cfg = { ...shiftCfg, demandCharge: oneMonth(10000, 4100) };
    const rows = solve(cfg);
    expect(rows.slice(4).every((r) => r.imp < 1e-6)).toBe(true);
    expect(peak(rows)).toBeLessThanOrEqual(4100 + 1e-6);
    expect(summarizeDemandCharge(rows, cfg.demandCharge)[0].excess_W).toBe(0);
  });

  it('applies each billing period separately across a month boundary', () => {
    // Slots 0-3 are the end of a month whose peak already reached 5 kW; slots 4-7 are a
    // new month that starts from the 2.5 kW minimum. A flat 3.5 kW load fits under 5 kW
    // in the old month, so the battery is pre-charged there to keep the new month at 2.5 kW.
    const cfg = {
      ...baseCfg,
      load_W: Array(T).fill(3500),
      demandCharge: {
        cost_cents_per_kW: 10000,
        periods: [
          { startSlot: 0, endSlot: 4, threshold_W: 5000 },
          { startSlot: 4, endSlot: T, threshold_W: 2500 },
        ],
      },
    };
    const rows = solve(cfg);
    expect(peak(rows.slice(0, 4))).toBeLessThanOrEqual(5000 + 1e-6);
    expect(peak(rows.slice(4))).toBeCloseTo(2500, 3);
    expect(summarizeDemandCharge(rows, cfg.demandCharge).map((p) => p.excess_W)).toEqual([0, 0]);
  });

  it('pays only for the lowest peak an EV with a minimum charge power needs', () => {
    // A three-phase charger cannot go below 3 × 6 A × 230 V = 4140 W. Delivering 8 kWh in
    // two hours needs 4 kW on average, so the cheapest peak is 4140 W in all eight slots
    // (spending a little extra energy) rather than e.g. ~4570 W in seven slots.
    const cfg = {
      ...baseCfg,
      maxChargePower_W: 0,
      maxDischargePower_W: 0,
      demandCharge: oneMonth(10000),
      ev: {
        evMinChargePower_W: 4140,
        evMaxChargePower_W: 11000,
        evBatteryCapacity_Wh: 60000,
        evInitialSoc_percent: 0,
        evChargeEfficiency_percent: 100,
        evMaxSoc_percent: 100,
        availabilityWindows: [{ startSlot: 0, endSlot: T }],
        targets: [{ slot: T - 1, soc_Wh: 8000 }],
      },
    };
    const rows = solve(cfg);
    expect(rows[T - 1].ev_soc_percent / 100 * 60000).toBeGreaterThanOrEqual(8000 - 1e-3);
    expect(peak(rows)).toBeCloseTo(4140, 3);
  });
});
