import { describe, it, expect } from 'vitest';
import { parseSolution, SolverStatusError } from '../../lib/parse-solution.ts';

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
      Status: 'Optimal',
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
    expect(rows[0].soc_Wh).toBe(200);
    expect(rows[0].soc_percent).toBe(20);
    expect(rows[0].timestampMs).toBe(1700000000000);
    expect(rows[1].timestampMs).toBe(1700000000000 + 3600000);
  });

  it('does not let soc_shortfall_* columns corrupt soc (regardless of key order)', () => {
    const result = {
      Status: 'Optimal',
      Columns: {
        'soc_0': { Primal: 200 },
        'soc_1': { Primal: 150 },
        // Emitted after soc_* here: the old startsWith("soc_") match would clobber soc.
        'soc_shortfall_0': { Primal: 999 },
        'soc_shortfall_1': { Primal: 999 },
      },
    };

    const rows = parseSolution(result, cfg, opts);

    expect(rows[0].soc_Wh).toBe(200);
    expect(rows[1].soc_Wh).toBe(150);
  });

  it('computes per-slot import and export costs', () => {
    const result = {
      Status: 'Optimal',
      Columns: {
        'grid_to_load_0': { Primal: 1000 },
        'pv_to_grid_0': { Primal: 500 },
        'grid_to_battery_1': { Primal: 500 },
        'battery_to_grid_1': { Primal: 1000 },
      },
    };
    const cfgWithSignedExport = {
      ...cfg,
      exportPrice: [5, -2],
    };

    const rows = parseSolution(result, cfgWithSignedExport, opts);

    expect(rows[0].importCost_cents).toBeCloseTo(10);
    expect(rows[0].exportCost_cents).toBeCloseTo(2.5);
    expect(rows[1].importCost_cents).toBeCloseTo(10);
    expect(rows[1].exportCost_cents).toBeCloseTo(-2);
  });

});

describe('parseSolution — solver status guard', () => {
  const cfg = {
    load_W: [500, 600],
    pv_W: [100, 0],
    importPrice: [10, 20],
    exportPrice: [5, 5],
    batteryCapacity_Wh: 1000,
  };
  const opts = { startMs: 1700000000000, stepMin: 60 };
  const columns = {
    'grid_to_load_0': { Primal: 400 },
    'pv_to_load_0': { Primal: 100 },
    'grid_to_load_1': { Primal: 600 },
    'soc_0': { Primal: 200 },
    'soc_1': { Primal: 200 },
  };

  it('throws a SolverStatusError naming the status for an infeasible solve', () => {
    const result = { Status: 'Infeasible', Columns: {} };
    expect(() => parseSolution(result, cfg, opts)).toThrow(SolverStatusError);
    expect(() => parseSolution(result, cfg, opts)).toThrow(/Infeasible/);
  });

  it('throws for an unbounded solve', () => {
    expect(() => parseSolution({ Status: 'Unbounded', Columns: {} }, cfg, opts)).toThrow(/Unbounded/);
  });

  it('throws for solver error statuses', () => {
    expect(() => parseSolution({ Status: 'Solve error', Columns: {} }, cfg, opts)).toThrow(/Solve error/);
  });

  it('throws when the status is missing entirely', () => {
    expect(() => parseSolution({ Columns: columns }, cfg, opts)).toThrow(/missing/);
  });

  it('still parses an Optimal result', () => {
    const rows = parseSolution({ Status: 'Optimal', Columns: columns }, cfg, opts);
    expect(rows).toHaveLength(2);
    expect(rows[0].g2l).toBe(400);
  });

  it('still parses a feasible incumbent under "Time limit reached"', () => {
    const rows = parseSolution({ Status: 'Time limit reached', Columns: columns }, cfg, opts);
    expect(rows).toHaveLength(2);
    expect(rows[0].soc_Wh).toBe(200);
  });

  it('throws for "Time limit reached" with empty columns (no incumbent found)', () => {
    const result = { Status: 'Time limit reached', Columns: {} };
    expect(() => parseSolution(result, cfg, opts)).toThrow(SolverStatusError);
    expect(() => parseSolution(result, cfg, opts)).toThrow(/without a feasible incumbent.*Time limit reached/);
  });

  it('throws for "Time limit reached" with non-finite primal values', () => {
    const result = {
      Status: 'Time limit reached',
      Columns: { ...columns, 'soc_1': { Primal: NaN } },
    };
    expect(() => parseSolution(result, cfg, opts)).toThrow(/without a feasible incumbent/);
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
      evChargeEfficiency_percent: 100,
      availabilityWindows: [{ startSlot: 0, endSlot: 1, resetSoc_Wh: 30000 }],
      targets: [{ slot: 0, soc_Wh: 48000 }],
    },
  };
  const opts = { startMs: 1700000000000, stepMin: 15 };

  function makeResult(g2ev, pv2ev, b2ev, pv2b = 0) {
    return {
      Status: 'Optimal',
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

  it('max — battery involved at configured charger maximum (+ grid + PV)', () => {
    const [row] = parseSolution(makeResult(1000, 500, 2180), evCfg, opts);
    expect(row.ev_charge_mode).toBe('max');
  });

  it('max — battery only, at configured charger maximum', () => {
    const [row] = parseSolution(makeResult(0, 0, 3680), evCfg, opts);
    expect(row.ev_charge_mode).toBe('max');
  });

  it('fixed — battery assists a partial planned rate below charger maximum', () => {
    const cfg = {
      ...evCfg,
      ev: {
        ...evCfg.ev,
        evMinChargePower_W: 1840, // 8 A
        evMaxChargePower_W: 5750, // 25 A
      },
    };
    // 1200 W PV + 1468 W battery = 2668 W = 11.6 A, below the 25 A charger ceiling.
    // Even if the battery is the limiting source, HA can reproduce the plan with exact amps.
    const [row] = parseSolution(makeResult(0, 1200, 1468), cfg, opts);
    expect(row.ev_charge_A).toBeCloseTo(11.6, 1);
    expect(row.ev_charge_mode).toBe('fixed');
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

describe('parseSolution — resolved EV targets on rows', () => {
  const opts = { startMs: 1700000000000, stepMin: 15 };

  function cfgWithTargets(targets) {
    return {
      load_W: [500, 500, 500],
      pv_W: [0, 0, 0],
      importPrice: [10, 10, 10],
      exportPrice: [5, 5, 5],
      batteryCapacity_Wh: 1000,
      ev: {
        evMinChargePower_W: 1380,
        evMaxChargePower_W: 3680,
        evBatteryCapacity_Wh: 60000,
        evInitialSoc_percent: 50,
        evChargeEfficiency_percent: 100,
        availabilityWindows: [{ startSlot: 0, endSlot: 3, resetSoc_Wh: 30000 }],
        targets,
      },
    };
  }

  const result = { Status: 'Optimal', Columns: { 'soc_0': { Primal: 0 }, 'soc_1': { Primal: 0 }, 'soc_2': { Primal: 0 } } };

  it('pins the target as a percentage on the slot that carries it', () => {
    const rows = parseSolution(result, cfgWithTargets([{ slot: 1, soc_Wh: 48000 }]), opts);
    expect(rows[0].ev_target_soc_percent).toBeUndefined();
    expect(rows[1].ev_target_soc_percent).toBeCloseTo(80);
    expect(rows[2].ev_target_soc_percent).toBeUndefined();
  });

  it('keeps the higher requirement when two targets share a slot', () => {
    const rows = parseSolution(
      result,
      cfgWithTargets([{ slot: 2, soc_Wh: 30000 }, { slot: 2, soc_Wh: 54000 }]),
      opts,
    );
    expect(rows[2].ev_target_soc_percent).toBeCloseTo(90);
  });

  it('leaves the field off every row when there is no EV config', () => {
    const cfg = cfgWithTargets([]);
    delete cfg.ev;
    const rows = parseSolution(result, cfg, opts);
    expect(rows.every(r => r.ev_target_soc_percent === undefined)).toBe(true);
  });
});
