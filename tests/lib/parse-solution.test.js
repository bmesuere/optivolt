import { describe, it, expect } from 'vitest';
import { parseSolution } from '../../lib/parse-solution.ts';

describe('parseSolution', () => {
  const cfg = {
    load_W: [500, 600],
    pv_W: [100, 0],
    importPrice: [10, 20],
    exportPrice: [5, 5],
    batteryCapacity_Wh: 1000,
  };

  const opts = {
    startMs: 1700000000000,
    stepMin: 60,
  };

  it('correctly parses HiGHS columns into rows', () => {
    const result = {
      Columns: {
        'grid_to_load_0': { Primal: 400 },
        'pv_to_load_0': { Primal: 100 },
        'grid_to_load_1': { Primal: 600 },
        'soc_0': { Primal: 200 },
        'soc_1': { Primal: 200 },
      },
    };

    const rows = parseSolution(result, cfg, opts);

    expect(rows).toHaveLength(2);
    expect(rows[0].g2l).toBe(400);
    expect(rows[0].pv2l).toBe(100);
    expect(rows[1].g2l).toBe(600);
    expect(rows[0].soc).toBe(200);
    expect(rows[0].soc_percent).toBe(20);
    expect(rows[0].timestampMs).toBe(1700000000000);
    expect(rows[1].timestampMs).toBe(1700000000000 + 3600000);
  });

});

describe('parseSolution — ev_charge_mode derivation', () => {
  const evCfg = {
    load_W: [500],
    pv_W: [300],
    importPrice: [10],
    exportPrice: [5],
    batteryCapacity_Wh: 1000,
    ev: {
      evMinChargePower_W: 1380,
      evMaxChargePower_W: 3680,
      evBatteryCapacity_Wh: 60000,
      evInitialSoc_percent: 50,
      evTargetSoc_percent: 80,
      evDepartureSlot: 4,
    },
  };
  const opts = { startMs: 1700000000000, stepMin: 15 };

  function makeResult(g2ev, pv2ev, b2ev) {
    return {
      Columns: {
        'grid_to_ev_0':    { Primal: g2ev },
        'pv_to_ev_0':      { Primal: pv2ev },
        'battery_to_ev_0': { Primal: b2ev },
        'ev_soc_0':        { Primal: 30000 },
      },
    };
  }

  it('off — no EV flows', () => {
    const [row] = parseSolution(makeResult(0, 0, 0), evCfg, opts);
    expect(row.ev_charge_mode).toBe('off');
  });

  it('fixed — grid only at minimum charge rate', () => {
    const [row] = parseSolution(makeResult(1380, 0, 0), evCfg, opts);
    expect(row.ev_charge_mode).toBe('fixed');
  });

  it('fixed — PV + tiny grid at minimum charge rate', () => {
    // Solver tops up minimum with a small grid contribution
    const [row] = parseSolution(makeResult(200, 1180, 0), evCfg, opts);
    expect(row.ev_charge_mode).toBe('fixed');
  });

  it('solar_plus — grid only, above minimum (same mode as PV+grid)', () => {
    const [row] = parseSolution(makeResult(2000, 0, 0), evCfg, opts);
    expect(row.ev_charge_mode).toBe('solar_plus');
  });

  it('solar — PV only, no grid or battery', () => {
    const [row] = parseSolution(makeResult(0, 2000, 0), evCfg, opts);
    expect(row.ev_charge_mode).toBe('solar');
  });

  it('solar_plus — PV + grid above minimum, no battery', () => {
    const [row] = parseSolution(makeResult(1000, 1000, 0), evCfg, opts);
    expect(row.ev_charge_mode).toBe('solar_plus');
  });

  it('max — battery involved (+ grid + PV)', () => {
    const [row] = parseSolution(makeResult(1000, 500, 500), evCfg, opts);
    expect(row.ev_charge_mode).toBe('max');
  });

  it('max — battery only (no PV or grid)', () => {
    const [row] = parseSolution(makeResult(0, 0, 2000), evCfg, opts);
    expect(row.ev_charge_mode).toBe('max');
  });
});
