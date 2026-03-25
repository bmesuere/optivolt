import { describe, it, expect } from 'vitest';
import { buildPlanSummary } from '../../lib/plan-summary.ts';

const cfg = { stepSize_m: 60 }; // 1-hour slots → W = kWh per slot

// Minimal row with all required PlanRow fields
function makeRow(overrides = {}) {
  return {
    tIdx: 0, timestampMs: 0,
    load: 0, pv: 0, ic: 0, ec: 0,
    g2l: 0, g2b: 0, pv2l: 0, pv2b: 0, pv2g: 0, b2l: 0, b2g: 0,
    imp: 0, exp: 0, soc: 0, soc_percent: 0,
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
