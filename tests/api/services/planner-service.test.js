import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all external I/O dependencies before importing the module under test
vi.mock('../../../api/services/settings-store.ts');
vi.mock('../../../api/services/data-store.ts');
vi.mock('../../../api/services/vrm-refresh.ts');
vi.mock('../../../api/services/mqtt-service.ts');

// Pass-through wrapper around the real solver, with a hook to simulate work
// (e.g. a settings edit) landing while the solve is running on the worker,
// and a capture of the arguments each solve was called with.
const solveHook = vi.hoisted(() => ({ onSolve: null, calls: [] }));
vi.mock('../../../api/services/solve-runner.ts', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    solveLp: (...args) => {
      solveHook.calls.push(args);
      solveHook.onSolve?.();
      return actual.solveLp(...args);
    },
  };
});

import { loadSettings, saveSettings } from '../../../api/services/settings-store.ts';
import { loadData, saveData } from '../../../api/services/data-store.ts';
import { refreshSeriesFromVrmAndPersist } from '../../../api/services/vrm-refresh.ts';
import { setDynamicEssSchedule } from '../../../api/services/mqtt-service.ts';
import { computePlan, planAndMaybeWrite, selectSolveOptions } from '../../../api/services/planner-service.ts';
import { FeedIn, Strategy } from '../../../lib/dess-mapper.ts';
import { bumpSolverInputsVersion } from '../../../api/services/solver-inputs-version.ts';

const NOW_STRING = '2024-01-01T00:00:00Z';
const NOW_MS = new Date(NOW_STRING).getTime();

// Minimal settings — use 60-min slots for a smaller LP
const baseSettings = {
  stepSize_m: 60,
  batteryCapacity_Wh: 10000,
  minSoc_percent: 20,
  maxSoc_percent: 100,
  maxChargePower_W: 1000,
  maxDischargePower_W: 1000,
  maxGridImport_W: 2000,
  maxGridExport_W: 2000,
  chargeEfficiency_percent: 100,
  dischargeEfficiency_percent: 100,
  batteryCost_cent_per_kWh: 0,
  idleDrain_W: 0,
  terminalSocValuation: 'zero',
  terminalSocCustomPrice_cents_per_kWh: 0,
  dataSources: { load: 'vrm', pv: 'vrm', prices: 'vrm', soc: 'mqtt' },
  dessAlgorithm: 'v1',
  rebalanceEnabled: false,
  rebalanceHoldHours: 2,
};

// 5 slots of data starting at NOW
const baseData = {
  load: { start: NOW_STRING, step: 60, values: [500, 500, 500, 500, 500] },
  pv: { start: NOW_STRING, step: 60, values: [0, 0, 0, 0, 0] },
  importPrice: { start: NOW_STRING, step: 60, values: [10, 10, 10, 10, 10] },
  exportPrice: { start: NOW_STRING, step: 60, values: [5, 5, 5, 5, 5] },
  soc: { timestamp: NOW_STRING, value: 50 },
};

describe('computePlan — rebalance bookkeeping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_STRING));
    vi.resetAllMocks();
    refreshSeriesFromVrmAndPersist.mockResolvedValue();
    setDynamicEssSchedule.mockResolvedValue();
    saveSettings.mockResolvedValue();
    saveData.mockResolvedValue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT set startMs when soc < maxSoc_percent (not at target yet)', async () => {
    // Fast charging + a generous import cap keep the rebalance MILP feasible
    // within the 5-slot horizon (parseSolution rejects infeasible solves).
    loadSettings.mockResolvedValue({
      ...baseSettings,
      rebalanceEnabled: true,
      maxChargePower_W: 5000,
      maxGridImport_W: 10000,
    });
    loadData.mockResolvedValue({ ...baseData, soc: { timestamp: NOW_STRING, value: 50 }, rebalanceState: { startMs: null } });

    await computePlan();

    // saveData should not have been called with a non-null startMs
    const savedDataCalls = saveData.mock.calls;
    const rebalanceSave = savedDataCalls.find(([d]) => d.rebalanceState?.startMs != null);
    expect(rebalanceSave).toBeUndefined();
  });

  it('sets startMs when soc >= maxSoc_percent (battery reached target)', async () => {
    loadSettings.mockResolvedValue({ ...baseSettings, rebalanceEnabled: true });
    loadData.mockResolvedValue({ ...baseData, soc: { timestamp: NOW_STRING, value: 100 }, rebalanceState: { startMs: null } });

    const result = await computePlan();

    // saveData should have been called with startMs set to NOW_MS
    expect(saveData).toHaveBeenCalledWith(
      expect.objectContaining({ rebalanceState: { startMs: NOW_MS } })
    );
    expect(result.rebalanceWindow).toEqual({ startIdx: 0, endIdx: 1 });
    expect(result.rows.slice(0, 2).map((row) => ({
      strategy: row.dess.strategy,
      socTarget_percent: row.dess.socTarget_percent,
    }))).toEqual([
      { strategy: Strategy.proBattery, socTarget_percent: 100 },
      { strategy: Strategy.proBattery, socTarget_percent: 100 },
    ]);
  });

  it('returns a rebalance nudge in the computed plan', async () => {
    loadSettings.mockResolvedValue(baseSettings);
    loadData.mockResolvedValue({
      ...baseData,
      lastFullSocAt: '2023-12-20T00:00:00.000Z',
    });

    const result = await computePlan();

    expect(result.rebalanceNudge).toMatchObject({
      lastFullSocAt: '2023-12-20T00:00:00.000Z',
      daysSinceLastFullSoc: 12,
      rebalanceRecommended: true,
      thresholdDays: 10,
    });
  });

  it('clears startMs and disables rebalancing when cycle is complete (remainingSlots = 0)', async () => {
    // holdHours=2, stepSize=60min → holdSlots=2; started 2h ago → remainingSlots=0
    const startMs = NOW_MS - 2 * 60 * 60_000;
    loadSettings.mockResolvedValue({ ...baseSettings, rebalanceEnabled: true, rebalanceHoldHours: 2 });
    loadData.mockResolvedValue({ ...baseData, rebalanceState: { startMs } });

    await computePlan();

    // Settings should be saved with rebalanceEnabled = false
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ rebalanceEnabled: false })
    );
    // Data should be saved with startMs = null
    expect(saveData).toHaveBeenCalledWith(
      expect.objectContaining({ rebalanceState: { startMs: null } })
    );
  });

  it('keeps feed-in allowed on negative export prices when blocking is disabled', async () => {
    loadSettings.mockResolvedValue({ ...baseSettings, blockFeedInOnNegativePrices: false });
    loadData.mockResolvedValue({
      ...baseData,
      exportPrice: { ...baseData.exportPrice, values: [-1, -1, -1, -1, -1] },
    });

    const result = await computePlan();

    expect(result.rows[0].dess.feedin).toBe(FeedIn.allowed);
  });

  it('throws on an infeasible solve and never writes to Victron', async () => {
    loadSettings.mockResolvedValue(baseSettings);
    // Load far exceeds max grid import + max discharge + PV every slot → infeasible.
    loadData.mockResolvedValue({
      ...baseData,
      load: { start: NOW_STRING, step: 60, values: [50000, 50000, 50000, 50000, 50000] },
      pv: { start: NOW_STRING, step: 60, values: [0, 0, 0, 0, 0] },
    });

    await expect(planAndMaybeWrite({ writeToVictron: true })).rejects.toThrow(/no usable solution.*Infeasible/i);
    expect(setDynamicEssSchedule).not.toHaveBeenCalled();
  });

  it('includes original prediction values on rows when manual adjustments changed them', async () => {
    loadSettings.mockResolvedValue(baseSettings);
    loadData.mockResolvedValue({
      ...baseData,
      pv: { start: NOW_STRING, step: 60, values: [100, 0, 0, 0, 0] },
      predictionAdjustments: [
        {
          id: 'load-add',
          series: 'load',
          mode: 'add',
          value_W: 100,
          start: NOW_STRING,
          end: '2024-01-01T01:00:00.000Z',
          createdAt: NOW_STRING,
          updatedAt: NOW_STRING,
        },
        {
          id: 'pv-off',
          series: 'pv',
          mode: 'set',
          value_W: 0,
          start: NOW_STRING,
          end: '2024-01-01T01:00:00.000Z',
          createdAt: NOW_STRING,
          updatedAt: NOW_STRING,
        },
      ],
    });

    const result = await computePlan();

    expect(result.rows[0]).toMatchObject({
      load: 600,
      originalLoad: 500,
      pv: 0,
      originalPv: 100,
    });
    expect(result.rows[1].originalLoad).toBeUndefined();
    expect(result.rows[1].originalPv).toBeUndefined();
  });
});

describe('computePlan — inputs changed during the solve', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_STRING));
    vi.resetAllMocks();
    refreshSeriesFromVrmAndPersist.mockResolvedValue();
    setDynamicEssSchedule.mockResolvedValue();
    saveSettings.mockResolvedValue();
    saveData.mockResolvedValue();
  });

  afterEach(() => {
    solveHook.onSolve = null;
    vi.useRealTimers();
  });

  it('marks the plan display-only and skips rebalance bookkeeping', async () => {
    // Cycle-complete scenario: without the mid-solve change, this would flip
    // rebalanceEnabled off and persist both stores.
    const startMs = NOW_MS - 2 * 60 * 60_000;
    loadSettings.mockResolvedValue({ ...baseSettings, rebalanceEnabled: true, rebalanceHoldHours: 2 });
    loadData.mockResolvedValue({ ...baseData, rebalanceState: { startMs } });
    solveHook.onSolve = () => bumpSolverInputsVersion();

    const result = await computePlan();

    expect(result.inputsChangedDuringSolve).toBe(true);
    expect(saveSettings).not.toHaveBeenCalled();
    expect(saveData).not.toHaveBeenCalled();
  });

  it('refuses the hardware write and reports fresh inputs otherwise', async () => {
    loadSettings.mockResolvedValue(baseSettings);
    loadData.mockResolvedValue({ ...baseData });
    solveHook.onSolve = () => bumpSolverInputsVersion();

    await expect(planAndMaybeWrite({ writeToVictron: true }))
      .rejects.toThrow(/inputs changed during the solve/);
    expect(setDynamicEssSchedule).not.toHaveBeenCalled();

    solveHook.onSolve = null;
    const plan = await planAndMaybeWrite({ writeToVictron: true });
    expect(plan.inputsChangedDuringSolve).toBe(false);
    expect(setDynamicEssSchedule).toHaveBeenCalled();
  });
});

describe('computePlan — warm start', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_STRING));
    vi.resetAllMocks();
    solveHook.calls = [];
    refreshSeriesFromVrmAndPersist.mockResolvedValue();
    setDynamicEssSchedule.mockResolvedValue();
    saveSettings.mockResolvedValue();
    saveData.mockResolvedValue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes the previous binary skeleton as a warm start on the next solve', async () => {
    loadSettings.mockResolvedValue({
      ...baseSettings,
      rebalanceEnabled: true,
      maxChargePower_W: 5000,
      maxGridImport_W: 10000,
    });
    loadData.mockResolvedValue({ ...baseData, soc: { timestamp: NOW_STRING, value: 50 }, rebalanceState: { startMs: null } });

    await computePlan();
    await computePlan();

    expect(solveHook.calls.length).toBe(2);
    const warm = solveHook.calls[1][2];
    expect(warm).toBeDefined();
    const keys = Object.keys(warm);
    expect(keys.length).toBeGreaterThan(0);
    // Only the binary skeleton is hinted, with exact 0/1 values
    for (const key of keys) {
      expect(key).toMatch(/^(ev_on|start_balance)_\d+$/);
      expect([0, 1]).toContain(warm[key]);
    }
    // Exactly one rebalance start is hinted at 1
    const startsAtOne = keys.filter((k) => k.startsWith('start_balance_') && warm[k] === 1);
    expect(startsAtOne.length).toBe(1);
  });
});

describe('selectSolveOptions', () => {
  const baseCfg = (slots) => ({
    load_W: Array(slots).fill(400),
    pv_W: Array(slots).fill(0),
    importPrice: Array(slots).fill(10),
    exportPrice: Array(slots).fill(5),
  });
  const ev = {
    evMinChargePower_W: 1380, evMaxChargePower_W: 3680,
    evBatteryCapacity_Wh: 60000, evInitialSoc_percent: 50,
    evChargeEfficiency_percent: 90,
    availabilityWindows: [], targets: [],
  };

  it('uses only a time limit for pure LPs', () => {
    expect(selectSolveOptions(baseCfg(384))).toEqual({ time_limit: 30 });
  });

  it('keeps the tight gap for a single binary family, even on large horizons', () => {
    expect(selectSolveOptions({ ...baseCfg(384), ev }).mip_rel_gap).toBe(0.005);
    expect(selectSolveOptions({ ...baseCfg(384), rebalance: { holdSlots: 12, remainingSlots: 12, targetSoc_percent: 100 } }).mip_rel_gap).toBe(0.005);
  });

  it('loosens the gap only for EV × rebalance beyond 200 slots', () => {
    const combo = (slots) => selectSolveOptions({ ...baseCfg(slots), ev, rebalance: { holdSlots: 12, remainingSlots: 12, targetSoc_percent: 100 } });
    expect(combo(200).mip_rel_gap).toBe(0.005); // boundary: 200 is still tight
    expect(combo(201).mip_rel_gap).toBe(0.02);  // boundary: first loosened size
    expect(combo(384)).toEqual({ mip_rel_gap: 0.02, mip_abs_gap: 0.01, time_limit: 30 });
  });

  it('treats a completed rebalance (0 remaining slots) as no rebalance', () => {
    expect(selectSolveOptions({ ...baseCfg(384), ev, rebalance: { holdSlots: 12, remainingSlots: 0, targetSoc_percent: 100 } }).mip_rel_gap).toBe(0.005);
  });
});
