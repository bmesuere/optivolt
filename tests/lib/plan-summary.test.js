import { describe, it, expect } from 'vitest';
import { buildPlanSummary } from '../../lib/plan-summary.ts';

const cfg = { stepSize_m: 60 }; // 1-hour slots → W = kWh per slot

// Minimal row with all required PlanRow fields
function makeRow(overrides = {}) {
  return {
    tIdx: 0, timestampMs: 0,
    load: 0, pv: 0, ic: 0, ec: 0,
    g2l: 0, g2b: 0, pv2l: 0, pv2b: 0, pv2g: 0, b2l: 0, b2g: 0,
    imp: 0, exp: 0, soc_Wh: 0, soc_percent: 0,
    g2ev: 0, pv2ev: 0, b2ev: 0,
    ev_charge: 0, ev_charge_A: 0, ev_charge_mode: 'off', ev_soc_percent: 0,
    ...overrides,
  };
}

describe('buildPlanSummary — EV energy totals', () => {
  it('returns zero EV totals for an empty row array', () => {
    const s = buildPlanSummary([], cfg);
    expect(s.evChargeTotal_kWh).toBe(0);
    expect(s.evChargeFromGrid_kWh).toBe(0);
    expect(s.evChargeFromPv_kWh).toBe(0);
    expect(s.evChargeFromBattery_kWh).toBe(0);
    expect(s.importCost_cents).toBe(0);
    expect(s.exportCost_cents).toBe(0);
    expect(s.netGridCost_cents).toBe(0);
  });

  it('returns zero EV totals when all EV fields are zero', () => {
    const s = buildPlanSummary([makeRow(), makeRow()], cfg);
    expect(s.evChargeTotal_kWh).toBe(0);
    expect(s.evChargeFromGrid_kWh).toBe(0);
  });

  it('sums EV energy from grid across slots', () => {
    const rows = [
      makeRow({ g2ev: 1000 }),  // 1000 W × 1 h = 1 kWh
      makeRow({ g2ev: 2000 }),  // 2 kWh
    ];
    const s = buildPlanSummary(rows, cfg);
    expect(s.evChargeFromGrid_kWh).toBeCloseTo(3);
    expect(s.evChargeTotal_kWh).toBeCloseTo(3);
  });

  it('sums EV energy from PV and battery separately', () => {
    const rows = [
      makeRow({ pv2ev: 1500, b2ev: 500 }),
    ];
    const s = buildPlanSummary(rows, cfg);
    expect(s.evChargeFromPv_kWh).toBeCloseTo(1.5);
    expect(s.evChargeFromBattery_kWh).toBeCloseTo(0.5);
    expect(s.evChargeTotal_kWh).toBeCloseTo(2);
  });

  it('totals all three EV sources combined', () => {
    const rows = [
      makeRow({ g2ev: 1000, pv2ev: 500, b2ev: 250 }),
      makeRow({ g2ev: 500,  pv2ev: 0,   b2ev: 0   }),
    ];
    const s = buildPlanSummary(rows, cfg);
    expect(s.evChargeFromGrid_kWh).toBeCloseTo(1.5);
    expect(s.evChargeFromPv_kWh).toBeCloseTo(0.5);
    expect(s.evChargeFromBattery_kWh).toBeCloseTo(0.25);
    expect(s.evChargeTotal_kWh).toBeCloseTo(2.25);
  });

  it('costs the grid share of EV charging at each slot price', () => {
    const rows = [
      makeRow({ g2ev: 1000, ic: 20 }),  // 1 kWh × 20 c€
      makeRow({ g2ev: 2000, ic: 5 }),   // 2 kWh × 5 c€
    ];
    const s = buildPlanSummary(rows, cfg);
    expect(s.evChargeGridCost_cents).toBeCloseTo(30);
    expect(s.evChargeEffectiveRate_cents_per_kWh).toBeCloseTo(10);
  });

  // Free PV/battery kWh dilute the rate below the grid price actually paid.
  it('spreads the grid cost over PV and battery energy too', () => {
    const rows = [makeRow({ g2ev: 1000, pv2ev: 1000, ic: 20 })];
    const s = buildPlanSummary(rows, cfg);
    expect(s.evChargeGridCost_cents).toBeCloseTo(20);
    expect(s.evChargeEffectiveRate_cents_per_kWh).toBeCloseTo(10);
  });

  it('reports a null effective rate when nothing charged', () => {
    expect(buildPlanSummary([], cfg).evChargeEffectiveRate_cents_per_kWh).toBeNull();
    expect(buildPlanSummary([makeRow()], cfg).evChargeEffectiveRate_cents_per_kWh).toBeNull();
    expect(buildPlanSummary([makeRow()], cfg).evChargeGridCost_cents).toBe(0);
  });

  it('handles rows where g2ev/pv2ev/b2ev are absent (undefined)', () => {
    // PlanRow without EV fields — summary should not throw and EV totals = 0
    const row = makeRow();
    delete row.g2ev;
    delete row.pv2ev;
    delete row.b2ev;
    const s = buildPlanSummary([row], cfg);
    expect(s.evChargeTotal_kWh).toBe(0);
  });
});

describe('buildPlanSummary — grid cost totals', () => {
  it('totals import, export, and net grid costs from slot rates and energy', () => {
    const rows = [
      makeRow({ imp: 1000, exp: 500, ic: 20, ec: 8 }),
      makeRow({ imp: 500, exp: 1000, ic: 10, ec: -2 }),
    ];

    const s = buildPlanSummary(rows, cfg);

    expect(s.importCost_cents).toBeCloseTo(25);
    expect(s.exportCost_cents).toBeCloseTo(2);
    expect(s.netGridCost_cents).toBeCloseTo(23);
  });

  it('uses parsed row costs when present', () => {
    const rows = [
      makeRow({ imp: 1000, exp: 1000, ic: 99, ec: 99, importCost_cents: 3, exportCost_cents: 1 }),
      makeRow({ imp: 1000, exp: 1000, ic: 99, ec: 99, importCost_cents: 4, exportCost_cents: -2 }),
    ];

    const s = buildPlanSummary(rows, cfg);

    expect(s.importCost_cents).toBeCloseTo(7);
    expect(s.exportCost_cents).toBeCloseTo(-1);
    expect(s.netGridCost_cents).toBeCloseTo(8);
  });
});

describe('buildPlanSummary — EV sessions', () => {
  const HOUR = 3_600_000;
  // cfg.stepSize_m is 60 here, so 1000 W for one slot is 1 kWh.
  const hourCfg = { ...cfg, stepSize_m: 60 };

  it('splits charging into runs of consecutive charging slots without an EV config', () => {
    const rows = [
      makeRow({ timestampMs: 0, ic: 20, g2ev: 2000, ev_charge: 2000 }),
      makeRow({ timestampMs: HOUR }),
      makeRow({ timestampMs: 2 * HOUR, ic: 10, g2ev: 1000, pv2ev: 1000, ev_charge: 2000 }),
    ];
    const s = buildPlanSummary(rows, hourCfg);
    expect(s.evSessions).toHaveLength(2);
    expect(s.evSessions[0]).toEqual({
      startMs: 0, endMs: HOUR, energy_kWh: 2, fromGrid_kWh: 2, fromPv_kWh: 0, fromBattery_kWh: 0,
      gridCost_cents: 40, batteryCost_cents: 0, cost_cents: 40, rate_cents_per_kWh: 20,
    });
    expect(s.evSessions[1].cost_cents).toBeCloseTo(10);
    expect(s.evSessions[1].rate_cents_per_kWh).toBeCloseTo(5);
  });

  it('keeps a pause inside one charging window in the same session', () => {
    const rows = [
      makeRow({ timestampMs: 0, ic: 20, g2ev: 1000, ev_charge: 1000 }),
      makeRow({ timestampMs: HOUR }),
      makeRow({ timestampMs: 2 * HOUR, ic: 10, g2ev: 1000, ev_charge: 1000 }),
    ];
    const ev = { availabilityWindows: [{ startSlot: 0, endSlot: 3 }] };
    const s = buildPlanSummary(rows, { ...hourCfg, ev });
    expect(s.evSessions).toHaveLength(1);
    expect(s.evSessions[0].endMs).toBe(3 * HOUR);
    expect(s.evSessions[0].cost_cents).toBeCloseTo(30);
  });

  it('costs battery energy at the battery energy price, discharge losses included', () => {
    const rows = [
      makeRow({ timestampMs: 0, b2ev: 900, ev_charge: 900, batteryEnergyPrice_cents_per_kWh: 12 }),
      makeRow({ timestampMs: HOUR, b2ev: 900, ev_charge: 900, batteryEnergyPrice_cents_per_kWh: 12 }),
    ];
    // Slot 0 uses the price at the start of the plan (18), slot 1 the price after slot 0 (12).
    const s = buildPlanSummary(rows, { ...hourCfg, dischargeEfficiency_percent: 90 }, {}, undefined, 18);
    expect(s.batteryEnergyPrice_cents_per_kWh).toBe(18);
    expect(s.evSessions[0].batteryCost_cents).toBeCloseTo(0.9 * 18 / 0.9 + 0.9 * 12 / 0.9);
    expect(s.evSessions[0].gridCost_cents).toBe(0);
  });
});
