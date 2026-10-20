import { describe, it, expect, beforeAll } from 'vitest';
// @ts-ignore — vendor build artifact has no types
import highsFactory from '../../vendor/highs-build/highs.js';
import { buildLP } from '../../lib/build-lp.ts';
import { parseSolution } from '../../lib/parse-solution.ts';

// End-to-end checks for the weekly charging mask and the home-battery floor.

let highs;
beforeAll(async () => {
  highs = await highsFactory({});
});

const T = 8;
const BAT_WH = 10000;

const baseCfg = {
  load_W: Array(T).fill(0),
  pv_W: Array(T).fill(0),
  importPrice: Array(T).fill(10),
  exportPrice: Array(T).fill(0),
  stepSize_m: 15,
  batteryCapacity_Wh: BAT_WH,
  minSoc_percent: 0,
  maxSoc_percent: 100,
  maxChargePower_W: 4000,
  maxDischargePower_W: 4000,
  maxGridImport_W: 10000,
  maxGridExport_W: 10000,
  chargeEfficiency_percent: 100,
  dischargeEfficiency_percent: 100,
  batteryCost_cent_per_kWh: 0,
  idleDrain_W: 0,
  terminalSocValuation: 'zero',
  terminalSocCustomPrice_cents_per_kWh: 0,
  evSocValue_cents_per_kWh: 0,
  initialSoc_percent: 50,
};

const baseEv = {
  evMinChargePower_W: 1000,
  evMaxChargePower_W: 3000,
  evBatteryCapacity_Wh: 60000,
  evInitialSoc_percent: 50,
  evChargeEfficiency_percent: 100,
  availabilityWindows: [{ startSlot: 0, endSlot: T, resetSoc_Wh: 30000 }],
  targets: [],
};

const solve = (cfg) => {
  const result = highs.solve(buildLP(cfg), {});
  expect(result.Status).toBe('Optimal');
  return parseSolution(result, cfg, { startMs: 0, stepMin: 15 });
};

describe('weekly charging mask', () => {
  it('only charges in allowed slots, even when other slots are cheaper', () => {
    const importPrice = [1, 1, 1, 1, 50, 50, 50, 50];
    const chargeAllowed = [false, false, false, false, true, true, true, true];
    const cfg = {
      ...baseCfg,
      importPrice,
      ev: { ...baseEv, chargeAllowed, targets: [{ slot: T - 1, soc_Wh: 31500 }] },
    };
    const rows = solve(cfg);
    for (let t = 0; t < 4; t++) expect(rows[t].ev_charge).toBeCloseTo(0, 6);
    expect(rows[T - 1].ev_soc_percent / 100 * 60000).toBeGreaterThanOrEqual(31500 - 1e-6);
  });

  it('pre-charges the home battery in cheap slots to feed the EV later', () => {
    const importPrice = [1, 1, 1, 1, 50, 50, 50, 50];
    const chargeAllowed = [false, false, false, false, true, true, true, true];
    const cfg = {
      ...baseCfg,
      initialSoc_percent: 0,
      importPrice,
      ev: { ...baseEv, chargeAllowed, targets: [{ slot: T - 1, soc_Wh: 33000 }] },
    };
    const rows = solve(cfg);
    const cheapGridToBattery = rows.slice(0, 4).reduce((s, r) => s + r.g2b, 0);
    const evFromBattery = rows.slice(4).reduce((s, r) => s + r.b2ev, 0);
    expect(cheapGridToBattery).toBeGreaterThan(0);
    expect(evFromBattery).toBeGreaterThan(0);
  });
});

describe('home battery SoC targets and floors', () => {
  it('stocks the battery up for a target only while power is cheaper than the penalty', () => {
    const importPrice = [5, 5, 30, 30, 30, 30, 30, 30];
    const cfg = { ...baseCfg, initialSoc_percent: 0, importPrice, socTargets: [{ slot: 5, soc_Wh: 4000 }] };
    // 20 c€/kWh: the two 5 c€ slots (2 × 1000 Wh) are worth buying, the 30 c€ ones are not.
    const cheapOnly = solve({ ...cfg, socTargetPenalty_cents_per_kWh: 20 });
    expect(cheapOnly[5].soc_Wh).toBeCloseTo(2000, 3);
    // 50 c€/kWh: now the target is worth 30 c€ power too.
    const atAnyPrice = solve({ ...cfg, socTargetPenalty_cents_per_kWh: 50 });
    expect(atAnyPrice[5].soc_Wh).toBeCloseTo(4000, 3);
  });

  it('keeps the battery at or above a floor', () => {
    const cfg = { ...baseCfg, load_W: Array(T).fill(2000), socFloors: [{ slot: 3, soc_Wh: 4500 }] };
    const rows = solve(cfg);
    // Only 500 Wh may be used before the floor slot; the four slots after it use 2000 Wh.
    expect(rows[3].soc_Wh).toBeCloseTo(4500, 3);
    expect(rows[T - 1].soc_Wh).toBeCloseTo(2500, 3);
  });
});

describe('home battery floor', () => {
  it('blocks grid and battery charging while the battery is below the floor', () => {
    // Battery at 20%, floor at 50%, no PV: grid→EV must wait until the battery is back at 50%.
    const cfg = {
      ...baseCfg,
      initialSoc_percent: 20,
      ev: { ...baseEv, essSocFloor_Wh: 5000, targets: [{ slot: T - 1, soc_Wh: 31000 }] },
    };
    const rows = solve(cfg);
    let prevSocWh = 2000;
    for (const r of rows) {
      const endSocWh = (r.soc_percent / 100) * BAT_WH;
      if (r.g2ev > 1 || r.b2ev > 1) {
        expect(prevSocWh).toBeGreaterThanOrEqual(5000 - 1e-6);
        expect(endSocWh).toBeGreaterThanOrEqual(5000 - 1e-6);
      }
      prevSocWh = endSocWh;
    }
    expect(rows[T - 1].ev_soc_percent / 100 * 60000).toBeGreaterThanOrEqual(31000 - 1e-6);
    expect(rows[0].g2ev + rows[0].b2ev).toBeCloseTo(0, 6);
  });

  it('keeps the floor and misses the target when the target is unreachable under the floor', () => {
    // Battery stuck at 20% (it cannot charge), no PV: the EV has no permitted source, so the
    // target cannot be met. The plan must stay solvable instead of going infeasible.
    const cfg = {
      ...baseCfg,
      initialSoc_percent: 20,
      maxChargePower_W: 0,
      ev: { ...baseEv, essSocFloor_Wh: 5000, targets: [{ slot: T - 1, soc_Wh: 31000 }] },
    };
    const rows = solve(cfg);
    for (const r of rows) expect(r.ev_charge).toBeCloseTo(0, 6);
    expect(rows[T - 1].ev_soc_percent).toBeCloseTo(50, 6);
  });

  it('charges as far as the floor allows when the target is only partly reachable', () => {
    // 6000 Wh in the battery, floor at 5000 Wh, no grid import:
    // only the 1000 Wh above the floor can reach the EV, well short of the 3000 Wh target.
    const cfg = {
      ...baseCfg,
      initialSoc_percent: 60,
      maxChargePower_W: 0,
      maxGridImport_W: 0,
      ev: { ...baseEv, essSocFloor_Wh: 5000, targets: [{ slot: T - 1, soc_Wh: 33000 }] },
    };
    const rows = solve(cfg);
    expect(rows.reduce((s, r) => s + r.b2ev, 0) * 0.25).toBeCloseTo(1000, 3);
    for (const r of rows) expect((r.soc_percent / 100) * BAT_WH).toBeGreaterThanOrEqual(5000 - 1e-6);
    expect((rows[T - 1].ev_soc_percent / 100) * 60000).toBeCloseTo(31000, 3);
  });

  it('lets the EV charge from the grid below the floor in slots cheaper than the battery energy', () => {
    // Battery stuck at 20% under a 50% floor. Slots 2 and 3 cost 5, below the 8 c€ battery
    // energy price, so the grid may feed the EV there; the 10 c€ slots stay blocked.
    const cfg = {
      ...baseCfg,
      initialSoc_percent: 20,
      maxChargePower_W: 0,
      importPrice: [10, 10, 5, 5, 10, 10, 10, 10],
      ev: {
        ...baseEv,
        essSocFloor_Wh: 5000,
        essFloorGridPriceLimit_cents_per_kWh: 8,
        targets: [{ slot: T - 1, soc_Wh: 33000 }],
      },
    };
    const rows = solve(cfg);
    rows.forEach((r, t) => {
      expect(r.b2ev).toBeCloseTo(0, 6);
      if (t !== 2 && t !== 3) expect(r.g2ev).toBeCloseTo(0, 6);
    });
    expect(rows[2].g2ev).toBeCloseTo(3000, 3);
    expect(rows[3].g2ev).toBeCloseTo(3000, 3);
  });

  it('plans around fixed EV flows without deciding anything about the EV', () => {
    // Flows fixed from outside: the target (unreachable with them) and the floor are ignored.
    const b2ev = [0, 0, 2000, 2000, 0, 0, 0, 0];
    const cfg = {
      ...baseCfg,
      initialSoc_percent: 20,
      ev: {
        ...baseEv,
        essSocFloor_Wh: 5000,
        targets: [{ slot: T - 1, soc_Wh: 50000 }],
        fixedFlows: { g2ev: Array(T).fill(0), pv2ev: Array(T).fill(0), b2ev },
      },
    };
    const rows = solve(cfg);
    rows.forEach((r, t) => {
      expect(r.b2ev).toBeCloseTo(b2ev[t], 6);
      expect(r.g2ev).toBeCloseTo(0, 6);
    });
    expect((rows[T - 1].ev_soc_percent / 100) * 60000).toBeCloseTo(31000, 3);
  });

  it('still allows PV charging below the floor', () => {
    const cfg = {
      ...baseCfg,
      initialSoc_percent: 0,
      maxChargePower_W: 0, // battery cannot recover: only PV may charge the EV
      pv_W: Array(T).fill(2000),
      exportPrice: Array(T).fill(-5), // exporting costs money, so PV goes to the EV
      ev: { ...baseEv, essSocFloor_Wh: 5000 },
    };
    const rows = solve(cfg);
    for (const r of rows) {
      expect(r.g2ev).toBeCloseTo(0, 6);
      expect(r.b2ev).toBeCloseTo(0, 6);
    }
    expect(rows.reduce((s, r) => s + r.pv2ev, 0)).toBeGreaterThan(0);
  });
});
