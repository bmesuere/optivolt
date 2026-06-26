import { describe, it, expect } from 'vitest';
import { buildLP } from '../../lib/build-lp.ts';

describe('buildLP', () => {
  const T = 5;
  const mockData = {
    load_W: Array(T).fill(500),
    pv_W: Array(T).fill(1000),
    importPrice: Array(T).fill(10),
    exportPrice: Array(T).fill(5),
  };

  it('throws if arrays have mismatched lengths', () => {
    expect(() => buildLP({
      ...mockData,
      load_W: [500] // Length 1 vs 5
    })).toThrow('Arrays must have same length');
  });

  it('generates a valid LP string structure', () => {
    const lp = buildLP(mockData);
    expect(lp).toBeTypeOf('string');
    expect(lp).toContain('Minimize');
    expect(lp).toContain('Subject To');
    expect(lp).toContain('Bounds');
    expect(lp).toContain('End');
  });

  it('includes expected variables for T=5', () => {
    const lp = buildLP(mockData);
    // Check for variables at t=0 and t=4
    expect(lp).toContain('grid_to_load_0');
    expect(lp).toContain('pv_to_grid_4');
    expect(lp).toContain('soc_shortfall_0');
  });

  it('handles custom step size', () => {
    // Just checking it doesn't crash; logic verification would require parsing the coefficients
    const lp = buildLP({ ...mockData, stepSize_m: 60 });
    expect(lp).toBeTypeOf('string');
  });

  it('handles terminal SOC valuation', () => {
    const lp = buildLP({ ...mockData, terminalSocValuation: 'max' });
    expect(lp).toContain('soc_4'); // Should be in objective if valued
  });

  it('subtracts default idle drain (40 W) from SOC constraints', () => {
    const lp = buildLP(mockData);
    // Default: 40 W * 0.25 h = 10 Wh per slot
    // initialSoc default is 20% of 204800 = 40960 Wh; soc_0 RHS = 40960 - 10 = 40950
    expect(lp).toContain('c_soc_0:');
    expect(lp).toMatch(/c_soc_0:.*= 40950\b/);
    // soc_1..soc_4 RHS = -10
    expect(lp).toMatch(/c_soc_1:.*= -10\b/);
  });

  it('applies custom idle drain to SOC constraints', () => {
    const lp = buildLP({ ...mockData, idleDrain_W: 100 });
    // 100 W * 0.25 h = 25 Wh per slot
    // soc_0 RHS = 40960 - 25 = 40935
    expect(lp).toMatch(/c_soc_0:.*= 40935\b/);
    expect(lp).toMatch(/c_soc_1:.*= -25\b/);
  });

  it('produces zero RHS for SOC evolution when idle drain is 0', () => {
    const lp = buildLP({ ...mockData, idleDrain_W: 0 });
    // soc_0 RHS = 40960 (no drain)
    expect(lp).toMatch(/c_soc_0:.*= 40960\b/);
    // soc_1..soc_4 RHS = 0
    expect(lp).toMatch(/c_soc_1:.*= 0\b/);
  });
});

describe('buildLP — MILP rebalancing', () => {
  const T = 8;
  const D = 3; // hold window in slots
  const mockData = {
    load_W: Array(T).fill(500),
    pv_W: Array(T).fill(0),
    importPrice: Array(T).fill(10),
    exportPrice: Array(T).fill(5),
    batteryCapacity_Wh: 10000,
    maxSoc_percent: 100,
  };

  it('does NOT include Binaries block when rebalanceRemainingSlots is 0', () => {
    const lp = buildLP({ ...mockData, rebalanceRemainingSlots: 0 });
    expect(lp).not.toContain('Binaries');
    expect(lp).not.toContain('start_balance_');
  });

  it('does NOT include Binaries block when rebalanceRemainingSlots is undefined', () => {
    const lp = buildLP(mockData);
    expect(lp).not.toContain('Binaries');
    expect(lp).not.toContain('start_balance_');
  });

  it('includes a Binaries block with start_balance_k variables when D > 0', () => {
    const lp = buildLP({ ...mockData, rebalanceRemainingSlots: D, rebalanceTargetSoc_percent: 100 });
    expect(lp).toContain('Binaries');
    // T=8, D=3 → start positions 0..5 (T-D = 5)
    for (let k = 0; k <= T - D; k++) {
      expect(lp).toContain(`start_balance_${k}`);
    }
    // No variable beyond T-D
    expect(lp).not.toContain(`start_balance_${T - D + 1}`);
  });

  it('includes exactly-one-start constraint', () => {
    const lp = buildLP({ ...mockData, rebalanceRemainingSlots: D, rebalanceTargetSoc_percent: 100 });
    // All T-D+1 start variables must appear in c_balance_start
    expect(lp).toContain('c_balance_start:');
    expect(lp).toMatch(/c_balance_start:.*= 1/);
  });

  it('includes per-slot SoC forcing constraints referencing targetSoc_Wh', () => {
    const targetSoc_Wh = (100 / 100) * 10000; // = 10000
    const lp = buildLP({ ...mockData, rebalanceRemainingSlots: D, rebalanceTargetSoc_percent: 100 });
    // Every slot that can be in the window should have a c_rebalance_t constraint
    expect(lp).toContain('c_rebalance_0:');
    expect(lp).toContain(`${targetSoc_Wh}`);
  });

  it('clamps D to T when rebalanceRemainingSlots > T, constraining the entire horizon', () => {
    // D = 20 > T = 8 → clamp to T=8; only one start position (k=0), whole horizon constrained
    const lp = buildLP({ ...mockData, rebalanceRemainingSlots: 20, rebalanceTargetSoc_percent: 100 });
    expect(lp).toContain('Binaries');
    expect(lp).toContain('start_balance_0');
    // No start_balance_1 — only k=0 is valid when D=T
    expect(lp).not.toContain('start_balance_1');
    expect(lp).toContain('c_balance_start: start_balance_0 = 1');
  });

  it('truncates fractional rebalanceRemainingSlots to integer', () => {
    // 2.9 should be treated as 2, not 3
    const lp = buildLP({ ...mockData, rebalanceRemainingSlots: 2.9, rebalanceTargetSoc_percent: 100 });
    // With D=2, T=8: start positions 0..6 (T-D=6)
    expect(lp).toContain('start_balance_6');
    expect(lp).not.toContain('start_balance_7'); // would only exist if D were treated as 1
  });

  it('clamps rebalanceTargetSoc_percent to maxSoc_percent to prevent infeasible models', () => {
    // If target exceeds max, model would be infeasible (soc_t >= targetSoc > maxSoc_Wh upper bound).
    // Clamping ensures the forced target == max bound.
    const targetAboveMax = 120; // > maxSoc_percent=100
    const lp = buildLP({ ...mockData, rebalanceRemainingSlots: D, rebalanceTargetSoc_percent: targetAboveMax });
    // The actual Wh coefficient in constraints must be based on maxSoc_percent (100%), not 120%
    const expectedTargetSoc_Wh = (100 / 100) * 10000; // = 10000
    expect(lp).toContain(`${expectedTargetSoc_Wh} start_balance_`);
    // Should NOT contain the unclamped 12000 (120% of 10000)
    expect(lp).not.toContain('12000 start_balance_');
  });
});

describe('buildLP — EV charging (MILP)', () => {
  const T = 5;
  const base = {
    load_W: Array(T).fill(500),
    pv_W: Array(T).fill(1000),
    importPrice: Array(T).fill(10),
    exportPrice: Array(T).fill(5),
    batteryCapacity_Wh: 10000,
    maxDischargePower_W: 4000,
    maxGridImport_W: 2500,
  };
  const evCfg = {
    evMinChargePower_W: 1380,
    evMaxChargePower_W: 3680,
    evBatteryCapacity_Wh: 60000,
    evInitialSoc_percent: 50,  // → 30 000 Wh
    // Available the whole horizon [0, 5); target 80% (= 48 000 Wh) by slot 3.
    availabilityWindows: [{ startSlot: 0, endSlot: T, resetSoc_Wh: 30000 }],
    targets: [{ slot: 3, soc_Wh: 48000 }],
  };

  it('does not include EV variables or Binaries when ev is not set', () => {
    const lp = buildLP(base);
    expect(lp).not.toContain('grid_to_ev_');
    expect(lp).not.toContain('ev_on_');
    expect(lp).not.toContain('Binaries');
  });

  it('includes EV flow variables in Bounds for every slot', () => {
    const lp = buildLP({ ...base, ev: evCfg });
    for (let t = 0; t < T; t++) {
      expect(lp).toContain(`grid_to_ev_${t}`);
      expect(lp).toContain(`pv_to_ev_${t}`);
      expect(lp).toContain(`battery_to_ev_${t}`);
      expect(lp).toContain(`ev_soc_${t}`);
    }
  });

  it('includes ev_on binary variables in the Binaries section', () => {
    const lp = buildLP({ ...base, ev: evCfg });
    expect(lp).toContain('Binaries');
    for (let t = 0; t < T; t++) {
      expect(lp).toContain(`ev_on_${t}`);
    }
  });

  it('includes min/max power constraints for each EV slot', () => {
    const lp = buildLP({ ...base, ev: evCfg });
    expect(lp).toContain('c_ev_min_0:');
    expect(lp).toContain('c_ev_max_0:');
    expect(lp).toContain(`c_ev_min_${T - 1}:`);
  });

  it('includes EV SoC evolution constraints with correct initial Wh', () => {
    const lp = buildLP({ ...base, ev: evCfg });
    // c_ev_soc_0 RHS = initialWh = 50% of 60000 = 30000
    expect(lp).toContain('c_ev_soc_0:');
    expect(lp).toMatch(/c_ev_soc_0:.*= 30000\b/);
    // chained constraints for t >= 1
    expect(lp).toContain('c_ev_soc_1:');
    expect(lp).toMatch(/c_ev_soc_1:.*= 0\b/);
  });

  it('includes a target SoC constraint at each target slot', () => {
    const lp = buildLP({ ...base, ev: evCfg });
    // target { slot: 3, soc_Wh: 48000 } → ev_soc_3 >= 48000
    expect(lp).toContain('c_ev_target_3:');
    expect(lp).toMatch(/c_ev_target_3:.*ev_soc_3.*>= 48000\b/);
  });

  it('adds pv_to_ev term to PV split constraints', () => {
    const lp = buildLP({ ...base, ev: evCfg });
    expect(lp).toMatch(/c_pv_split_0:.*pv_to_ev_0/);
  });

  it('adds battery_to_ev term to discharge cap constraints', () => {
    const lp = buildLP({ ...base, ev: evCfg });
    expect(lp).toMatch(/c_discharge_cap_0:.*battery_to_ev_0/);
  });

  it('adds grid_to_ev term to grid import cap constraints', () => {
    const lp = buildLP({ ...base, ev: evCfg });
    expect(lp).toMatch(/c_grid_import_cap_0:.*grid_to_ev_0/);
  });

  it('omits target constraints when targets is empty', () => {
    const lp = buildLP({ ...base, ev: { ...evCfg, targets: [] } });
    expect(lp).not.toContain('c_ev_target_');
  });

  it('applies evChargeEfficiency_percent to EV SoC evolution coefficients', () => {
    // 90% efficiency → evChargeWhPerW = 0.25 * 0.9 = 0.225
    const lp = buildLP({ ...base, ev: { ...evCfg, evChargeEfficiency_percent: 90 } });
    expect(lp).toMatch(/c_ev_soc_0:.*0\.225 grid_to_ev_0/);
    expect(lp).toMatch(/c_ev_soc_1:.*0\.225 grid_to_ev_1/);
  });

  it('uses bare stepHours (0.25) in EV SoC constraints when efficiency is 100%', () => {
    const lp = buildLP({ ...base, ev: { ...evCfg, evChargeEfficiency_percent: 100 } });
    expect(lp).toMatch(/c_ev_soc_0:.*0\.25 grid_to_ev_0/);
  });

  it('values terminal EV SoC in the objective when evSocValue_cents_per_kWh > 0', () => {
    // 20 c€/kWh → 0.02 c€/Wh, no discharge-efficiency factor; valued at the last
    // available slot, which for the full-horizon window [0,5) is index 4.
    const lp = buildLP({ ...base, ev: evCfg, evSocValue_cents_per_kWh: 20 });
    const objLine = lp.split('\n').find((l) => l.trim().startsWith('obj:'));
    expect(objLine).toMatch(/- 0\.02 ev_soc_4\b/);
  });

  it('values EV SoC at the last available slot, not the horizon end', () => {
    // Window [0,3) → last available slot is index 2. No charging is rewarded after departure.
    const lp = buildLP({
      ...base,
      ev: { ...evCfg, availabilityWindows: [{ startSlot: 0, endSlot: 3, resetSoc_Wh: 30000 }], targets: [] },
      evSocValue_cents_per_kWh: 20,
    });
    const objLine = lp.split('\n').find((l) => l.trim().startsWith('obj:'));
    expect(objLine).toMatch(/- 0\.02 ev_soc_2\b/);
    expect(objLine).not.toMatch(/ev_soc_4\b/);
  });

  it('omits the EV SoC valuation term when no slot is available', () => {
    const lp = buildLP({
      ...base,
      ev: { ...evCfg, availabilityWindows: [], targets: [] },
      evSocValue_cents_per_kWh: 20,
    });
    const objLine = lp.split('\n').find((l) => l.trim().startsWith('obj:'));
    expect(objLine).not.toContain('ev_soc_');
  });

  it('does not value EV SoC when evSocValue_cents_per_kWh is 0', () => {
    const lp = buildLP({ ...base, ev: evCfg, evSocValue_cents_per_kWh: 0 });
    // ev_soc_t still appears in constraints; assert only the objective has no valuation term.
    const objLine = lp.split('\n').find((l) => l.trim().startsWith('obj:'));
    expect(objLine).not.toContain('ev_soc_');
  });

  it('does not value EV SoC when ev is not configured', () => {
    const lp = buildLP({ ...base, evSocValue_cents_per_kWh: 20 });
    expect(lp).not.toContain('ev_soc_');
  });

  it('does not emit force-off constraints when the EV is available the whole horizon', () => {
    const lp = buildLP({ ...base, ev: evCfg });
    expect(lp).not.toContain('c_ev_off_');
  });

  it('forces ev_on = 0 for every slot before arrival', () => {
    const lp = buildLP({ ...base, ev: { ...evCfg, availabilityWindows: [{ startSlot: 3, endSlot: T, resetSoc_Wh: 30000 }] } });
    // slots 0..2 forced off, slots 3+ free to charge
    expect(lp).toMatch(/c_ev_off_0: ev_on_0 = 0\b/);
    expect(lp).toContain('c_ev_off_1: ev_on_1 = 0');
    expect(lp).toContain('c_ev_off_2: ev_on_2 = 0');
    expect(lp).not.toContain('c_ev_off_3:');
  });

  it('forces ev_on = 0 for every slot after departure', () => {
    // Window [0,3): the car leaves at slot 3, so slots 3,4 must be forced off.
    const lp = buildLP({ ...base, ev: { ...evCfg, availabilityWindows: [{ startSlot: 0, endSlot: 3, resetSoc_Wh: 30000 }], targets: [] } });
    expect(lp).not.toContain('c_ev_off_0:');
    expect(lp).not.toContain('c_ev_off_2:');
    expect(lp).toContain('c_ev_off_3: ev_on_3 = 0');
    expect(lp).toContain('c_ev_off_4: ev_on_4 = 0');
  });

  it('keeps charging available after an early target deadline (decoupled)', () => {
    // Available all horizon [0,5), but a target deadline at slot 2. Slots 3,4 stay chargeable.
    const lp = buildLP({ ...base, ev: { ...evCfg, targets: [{ slot: 2, soc_Wh: 40000 }] } });
    expect(lp).toContain('c_ev_target_2:');
    expect(lp).not.toContain('c_ev_off_3:');
    expect(lp).not.toContain('c_ev_off_4:');
  });

  it('forces ev_on = 0 for all slots and omits targets when no window is available', () => {
    const lp = buildLP({ ...base, ev: { ...evCfg, availabilityWindows: [], targets: [] } });
    for (let t = 0; t < T; t++) {
      expect(lp).toContain(`c_ev_off_${t}: ev_on_${t} = 0`);
    }
    expect(lp).not.toContain('c_ev_target_');
    expect(lp).not.toContain('c_ev_min_on:');
  });

  it('resets the SoC chain at a window start with resetSoc_Wh (forward-compat)', () => {
    // Two windows; the second starts at slot 3 with a reset to 20000 Wh (a returning trip).
    const lp = buildLP({
      ...base,
      ev: {
        ...evCfg,
        availabilityWindows: [
          { startSlot: 0, endSlot: 2, resetSoc_Wh: 30000 },
          { startSlot: 3, endSlot: T, resetSoc_Wh: 20000 },
        ],
        targets: [],
      },
    });
    // The window-start slot uses an absolute RHS reset (no chained - ev_soc_2 term).
    expect(lp).toMatch(/c_ev_soc_3:.*= 20000\b/);
    expect(lp).not.toMatch(/c_ev_soc_3:.*ev_soc_2/);
  });

  it('counts only available slots in the c_ev_min_on cardinality bound', () => {
    // initial 75% = 45000, target 80% = 48000 → deficit 3000 Wh.
    // perSlot = 0.25 * 3680 = 920 → kMin = ceil(3000/920) = 4; available slots [1,5) = 4.
    const lp = buildLP({
      ...base,
      ev: {
        ...evCfg,
        evInitialSoc_percent: 75,
        availabilityWindows: [{ startSlot: 1, endSlot: T, resetSoc_Wh: 45000 }],
        targets: [{ slot: 4, soc_Wh: 48000 }],
      },
    });
    const onLine = lp.split('\n').find((l) => l.trim().startsWith('c_ev_min_on:'));
    expect(onLine).toBeDefined();
    // The bound must not reference the forced-off slot 0, and must require all 4 remaining slots.
    expect(onLine).not.toMatch(/\bev_on_0\b/);
    expect(onLine).toMatch(/>= 4\b/);
  });
});
