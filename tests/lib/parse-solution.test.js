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

  function makeResult(g2ev, pv2ev, b2ev, pv2b = 0) {
    return {
      Columns: {
        'grid_to_ev_0':    { Primal: g2ev },
        'pv_to_ev_0':      { Primal: pv2ev },
        'battery_to_ev_0': { Primal: b2ev },
        'pv_to_battery_0': { Primal: pv2b },
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

  it('solar_grid — grid only, above minimum (same mode as PV+grid)', () => {
    const [row] = parseSolution(makeResult(2000, 0, 0), evCfg, opts);
    expect(row.ev_charge_mode).toBe('solar_grid');
  });

  it('solar_only — PV only, no grid or battery', () => {
    const [row] = parseSolution(makeResult(0, 2000, 0), evCfg, opts);
    expect(row.ev_charge_mode).toBe('solar_only');
  });

  it('solar_grid — PV + grid above minimum, no battery', () => {
    const [row] = parseSolution(makeResult(1000, 1000, 0), evCfg, opts);
    expect(row.ev_charge_mode).toBe('solar_grid');
  });

  it('max — battery involved above minimum rate (+ grid + PV)', () => {
    const [row] = parseSolution(makeResult(1000, 500, 500), evCfg, opts);
    expect(row.ev_charge_mode).toBe('max');
  });

  it('max — battery only, above minimum rate', () => {
    const [row] = parseSolution(makeResult(0, 0, 2000), evCfg, opts);
    expect(row.ev_charge_mode).toBe('max');
  });

  it('fixed — battery tops up to reach minimum charge rate (not max)', () => {
    // PV delivers 1150W, battery chips in 230W to reach 1380W minimum; not "max" speed
    const [row] = parseSolution(makeResult(0, 1150, 230), evCfg, opts);
    expect(row.ev_charge_mode).toBe('fixed');
  });

  it('fixed — PV to EV and PV to battery simultaneously (split PV)', () => {
    // Solver splits PV between EV and house battery; solar tracking would conflict
    const [row] = parseSolution(makeResult(0, 2000, 0, 500), evCfg, opts);
    expect(row.ev_charge_mode).toBe('fixed');
  });

  it('fixed — PV + grid to EV with PV also going to battery', () => {
    const [row] = parseSolution(makeResult(500, 1000, 0, 800), evCfg, opts);
    expect(row.ev_charge_mode).toBe('fixed');
  });

  it('solar_only — PV only to EV, no competing battery sink', () => {
    const [row] = parseSolution(makeResult(0, 2000, 0, 0), evCfg, opts);
    expect(row.ev_charge_mode).toBe('solar_only');
  });
});
