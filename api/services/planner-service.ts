// @ts-expect-error — no .d.ts alongside the vendor build artifact; type is asserted via HighsInstance below
import highsFactory from '../../vendor/highs-build/highs.js';
import { mapRowsToDessV2 } from '../../lib/dess-mapper.ts';
import { buildLP } from '../../lib/build-lp.ts';
import { parseSolution, type HighsSolution } from '../../lib/parse-solution.ts';
import { buildPlanSummary } from '../../lib/plan-summary.ts';
import { extractRebalanceWindow, type RebalanceWindow } from '../../lib/lp-vars.ts';
import type { SolverConfig, PlanSummary, PlanRow, TimeSeries } from '../../lib/types.ts';
import { getSolverInputs, buildSolverConfigFromSettings } from './config-builder.ts';
import { saveSettings } from './settings-store.ts';
import { saveData } from './data-store.ts';
import { applyPredictionAdjustmentsToData } from './prediction-adjustments.ts';
import { refreshSeriesFromVrmAndPersist } from './vrm-refresh.ts';
import { refreshPriceForecastAndPersist } from './price-forecast-service.ts';
import { setDynamicEssSchedule } from './mqtt-service.ts';
import { getRebalanceNudge, type RebalanceNudge } from './rebalance-nudge.ts';
import { getSolverInputsVersion } from './solver-inputs-version.ts';
import type { PlanRowWithDess, Data } from '../types.ts';

// How many slots we push into Dynamic ESS
const DESS_SLOTS = 4;
// Upper bound on a single HiGHS solve, in seconds. Current ~100-slot MILPs
// solve well under a second; this only kicks in when something degenerates
// (or once longer horizons multiply the binary count).
const SOLVE_TIME_LIMIT_S = 30;
// MIP gap tuning. The EV × rebalance combination on a multi-day horizon is
// the one slow case (4-day benchmark: 18.5 s at 0.5% gap vs 7.5 s at 2% on an
// M-series Mac — slower add-on hardware could hit the time limit, and a
// timed-out solve blocks hardware writes entirely). Loosen the gap for that
// combination only; everything else keeps the tight default.
const MIP_REL_GAP = 0.005;
const MIP_REL_GAP_LARGE = 0.02;
const LARGE_MILP_SLOTS = 200;

// Lazy, shared HiGHS instance
type HighsInstance = Awaited<ReturnType<typeof highsFactory>>;
let highsPromise: Promise<HighsInstance> | undefined;

async function getHighsInstance(): Promise<HighsInstance> {
  if (!highsPromise) {
    highsPromise = highsFactory({}).catch((error: unknown) => {
      highsPromise = undefined;
      throw error;
    });
  }
  return highsPromise;
}

export type { RebalanceWindow };

export interface ComputePlanResult {
  cfg: SolverConfig;
  data: Data;
  /** Wall-clock time the solve finished; lets clients judge cache freshness. */
  computedAtMs: number;
  /** Solver-inputs version this plan was built from; see solver-inputs-version.ts. */
  inputsVersion: number;
  timing: { startMs: number; stepMin: number };
  result: HighsSolution;
  rows: PlanRowWithDess[];
  summary: PlanSummary;
  rebalanceWindow?: RebalanceWindow;
  rebalanceNudge: RebalanceNudge;
}

function roundPower(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function valueAtTimestampPrecomputed(series: TimeSeries, timestampMs: number, startMs: number, stepMs: number): number | null {
  if (!Number.isFinite(startMs) || !Number.isFinite(stepMs) || stepMs <= 0) return null;
  const index = Math.floor((timestampMs - startMs) / stepMs);
  if (index < 0 || index >= series.values.length) return null;
  const value = Number(series.values[index]);
  return Number.isFinite(value) ? roundPower(value) : null;
}

function attachOriginalPredictionValues(rows: PlanRow[], data: Data): PlanRow[] {
  const loadStartMs = new Date(data.load.start).getTime();
  const loadStepMs = (data.load.step ?? 15) * 60_000;
  const pvStartMs = new Date(data.pv.start).getTime();
  const pvStepMs = (data.pv.step ?? 15) * 60_000;

  return rows.map(row => {
    const originalLoad = valueAtTimestampPrecomputed(data.load, row.timestampMs, loadStartMs, loadStepMs);
    const originalPv = valueAtTimestampPrecomputed(data.pv, row.timestampMs, pvStartMs, pvStepMs);
    const hasLoad = originalLoad != null && Math.abs(originalLoad - row.load) > 0.001;
    const hasPv = originalPv != null && Math.abs(originalPv - row.pv) > 0.001;
    if (!hasLoad && !hasPv) return row;
    return {
      ...row,
      ...(hasLoad ? { originalLoad } : {}),
      ...(hasPv ? { originalPv } : {}),
    };
  });
}

/**
 * Solver options for a config. The solve runs synchronously on the event
 * loop, so a runaway MIP would block every HTTP request; the time limit
 * bounds that (a limited solve comes back non-Optimal and is refused for
 * hardware writes). The EV × rebalance combination on a multi-day horizon
 * gets the loosened MIP gap; everything else keeps the tight default.
 */
export function selectSolveOptions(cfg: SolverConfig): { mip_rel_gap?: number; mip_abs_gap?: number; time_limit: number } {
  const hasEv = cfg.ev != null;
  const hasRebalance = (cfg.rebalanceRemainingSlots ?? 0) > 0;
  if (!hasEv && !hasRebalance) return { time_limit: SOLVE_TIME_LIMIT_S };
  const largeMilpCombo = hasEv && hasRebalance && cfg.load_W.length > LARGE_MILP_SLOTS;
  return {
    mip_rel_gap: largeMilpCombo ? MIP_REL_GAP_LARGE : MIP_REL_GAP,
    mip_abs_gap: 0.01,
    time_limit: SOLVE_TIME_LIMIT_S,
  };
}

// Cache of the last computed plan, used by /ev/* endpoints
let lastPlan: ComputePlanResult | undefined;

export function getLastPlan(): ComputePlanResult | undefined {
  return lastPlan;
}

export async function computePlan({ updateData = false } = {}): Promise<ComputePlanResult> {
  if (updateData) {
    try {
      await refreshSeriesFromVrmAndPersist();
    } catch (vrmError) {
      console.error(
        'Failed to refresh VRM data before calculation:',
        vrmError instanceof Error ? vrmError.message : String(vrmError),
      );
    }
    try {
      // No-op unless extendedHorizonDays > 0 and a priceForecastUrl is set.
      // On failure the previously stored forecast is kept and simply ages out.
      await refreshPriceForecastAndPersist();
    } catch (forecastError) {
      console.error(
        'Failed to refresh price forecast before calculation:',
        forecastError instanceof Error ? forecastError.message : String(forecastError),
      );
    }
  }

  const solverInputs = await getSolverInputs();
  const { timing } = solverInputs;
  let { cfg, data, settings } = solverInputs;

  // Pre-solve bookkeeping: if a rebalance cycle just completed, auto-disable
  if (settings.rebalanceEnabled && (cfg.rebalanceRemainingSlots ?? Infinity) === 0) {
    data = { ...data, rebalanceState: { startMs: null } };
    settings = { ...settings, rebalanceEnabled: false };
    await Promise.all([saveSettings(settings), saveData(data)]);
    // Rebuild cfg without rebalance constraints
    cfg = buildSolverConfigFromSettings(settings, applyPredictionAdjustmentsToData(data), timing.startMs);
  }

  // Captured after all pre-solve persistence so a plan built from inputs that
  // are mutated later (even by our own post-solve bookkeeping) reads as stale.
  const inputsVersion = getSolverInputsVersion();

  const lpText = buildLP(cfg);
  const highs = await getHighsInstance();
  const hasRebalance = (cfg.rebalanceRemainingSlots ?? 0) > 0;
  const solveOptions = selectSolveOptions(cfg);
  let result: ReturnType<typeof highs.solve>;
  const t0 = performance.now();
  try {
    result = highs.solve(lpText, solveOptions);
  } catch (err) {
    highsPromise = undefined; // force re-initialisation on next call
    throw err;
  }
  const solveMs = performance.now() - t0;
  const evCfg = cfg.ev;
  const evInfo = evCfg ? {
    windows: evCfg.availabilityWindows.map((w) => [w.startSlot, w.endSlot]),
    targets: evCfg.targets.map((t) => ({ slot: t.slot, soc_Wh: Math.round(t.soc_Wh) })),
    minW: evCfg.evMinChargePower_W,
    maxW: evCfg.evMaxChargePower_W,
  } : null;
  console.log('[calculate] solve', {
    slots: cfg.load_W.length,
    ev: evInfo,
    rebalance: hasRebalance,
    ...('mip_rel_gap' in solveOptions ? { mipRelGap: solveOptions.mip_rel_gap } : {}),
    solveMs: Math.round(solveMs),
    status: result.Status,
  });

  const rows = attachOriginalPredictionValues(parseSolution(result, cfg, timing), data);

  const rebalanceWindow = extractRebalanceWindow(
    result.Columns ?? {},
    cfg.rebalanceRemainingSlots ?? 0,
  );

  const { perSlot, diagnostics } = mapRowsToDessV2(rows, cfg, {
    blockFeedInOnNegativePrices: settings.blockFeedInOnNegativePrices !== false,
    rebalanceWindow,
  });

  const rowsWithDess: PlanRowWithDess[] = rows.map((row, i) => ({ ...row, dess: perSlot[i] }));

  // Post-solve bookkeeping: if rebalancing is enabled but hasn't started, check actual SoC
  if (settings.rebalanceEnabled && (data.rebalanceState?.startMs == null)) {
    if (data.soc.value >= settings.maxSoc_percent) {
      data = { ...data, rebalanceState: { startMs: timing.startMs } };
      await saveData(data);
    }
  }

  const rebalanceCtx = settings.rebalanceEnabled ? {
    enabled: true,
    startMs: data.rebalanceState?.startMs ?? null,
    remainingSlots: cfg.rebalanceRemainingSlots ?? 0,
  } : undefined;

  const summary = buildPlanSummary(rowsWithDess, cfg, diagnostics, rebalanceCtx);

  const rebalanceNudge = getRebalanceNudge(data);

  lastPlan = { cfg, data, computedAtMs: Date.now(), inputsVersion, timing, result, rows: rowsWithDess, summary, rebalanceWindow, rebalanceNudge };
  return lastPlan;
}

export async function writePlanToVictron(rows: PlanRowWithDess[], stepMin: number): Promise<void> {
  await setDynamicEssSchedule(rows, Math.min(DESS_SLOTS, rows.length), stepMin * 60);
}

export async function planAndMaybeWrite({
  updateData = false,
  writeToVictron = false,
} = {}): Promise<ComputePlanResult> {
  const plan = await computePlan({ updateData });
  if (writeToVictron) {
    // Never push a non-Optimal solve to the hardware: a feasible-but-unproven
    // incumbent (e.g. "Time limit reached") is fine to display but not to write.
    if (plan.result.Status !== 'Optimal') {
      throw new Error(`Refusing to write schedule to Victron: solver status is "${plan.result.Status ?? 'unknown'}" (expected "Optimal")`);
    }
    await writePlanToVictron(plan.rows, plan.timing.stepMin);
  }
  return plan;
}
