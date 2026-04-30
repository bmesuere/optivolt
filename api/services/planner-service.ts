// @ts-ignore — no .d.ts alongside the vendor build artifact; type is asserted via HighsInstance below
import highsFactory from '../../vendor/highs-build/highs.js';
import { mapRowsToDessV2 } from '../../lib/dess-mapper.ts';
import { buildLP } from '../../lib/build-lp.ts';
import { parseSolution, type HighsSolution } from '../../lib/parse-solution.ts';
import { buildPlanSummary } from '../../lib/plan-summary.ts';
import type { SolverConfig, PlanSummary, PlanRow, TimeSeries } from '../../lib/types.ts';
import { getSolverInputs, buildSolverConfigFromSettings } from './config-builder.ts';
import { saveSettings } from './settings-store.ts';
import { saveData } from './data-store.ts';
import { applyPredictionAdjustmentsToData } from './prediction-adjustments.ts';
import { refreshSeriesFromVrmAndPersist } from './vrm-refresh.ts';
import { setDynamicEssSchedule } from './mqtt-service.ts';
import type { PlanRowWithDess, Data } from '../types.ts';

// How many slots we push into Dynamic ESS
const DESS_SLOTS = 4;

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

export interface RebalanceWindow {
  startIdx: number;
  endIdx: number;
}

export interface ComputePlanResult {
  cfg: SolverConfig;
  data: Data;
  timing: { startMs: number; stepMin: number };
  result: HighsSolution;
  rows: PlanRowWithDess[];
  summary: PlanSummary;
  rebalanceWindow?: RebalanceWindow;
}

/**
 * Find which contiguous slot range the MILP solver selected for rebalancing.
 * Scans solution columns for the `start_balance_k` binary that equals 1.
 */
function extractRebalanceWindow(
  columns: Record<string, { Primal?: number }>,
  remainingSlots: number,
): RebalanceWindow | undefined {
  if (remainingSlots <= 0) return undefined;
  for (const [name, col] of Object.entries(columns)) {
    if (name.startsWith('start_balance_') && Math.round(col.Primal ?? 0) === 1) {
      const m = /_(\d+)$/.exec(name);
      if (!m) continue;
      const k = Number(m[1]);
      return { startIdx: k, endIdx: k + remainingSlots - 1 };
    }
  }
  return undefined;
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
  }

  let { cfg, timing, data, settings } = await getSolverInputs();

  // Pre-solve bookkeeping: if a rebalance cycle just completed, auto-disable
  if (settings.rebalanceEnabled && (cfg.rebalanceRemainingSlots ?? Infinity) === 0) {
    data = { ...data, rebalanceState: { startMs: null } };
    settings = { ...settings, rebalanceEnabled: false };
    await Promise.all([saveSettings(settings), saveData(data)]);
    // Rebuild cfg without rebalance constraints
    cfg = buildSolverConfigFromSettings(settings, applyPredictionAdjustmentsToData(data), timing.startMs);
  }

  const lpText = buildLP(cfg);
  const highs = await getHighsInstance();
  const hasBinaries = cfg.ev != null || (cfg.rebalanceRemainingSlots ?? 0) > 0;
  const solveOptions = hasBinaries ? { mip_rel_gap: 0.005, mip_abs_gap: 0.01 } : {};
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
    depSlot: evCfg.evDepartureSlot,
    deficitWh: Math.round((evCfg.evTargetSoc_percent - evCfg.evInitialSoc_percent) / 100 * evCfg.evBatteryCapacity_Wh),
    minW: evCfg.evMinChargePower_W,
    maxW: evCfg.evMaxChargePower_W,
  } : null;
  console.log('[calculate] solve', {
    slots: cfg.load_W.length,
    ev: evInfo,
    rebalance: (cfg.rebalanceRemainingSlots ?? 0) > 0,
    solveMs: Math.round(solveMs),
  });

  const rows = attachOriginalPredictionValues(parseSolution(result, cfg, timing), data);

  const { perSlot, diagnostics } = mapRowsToDessV2(rows, cfg, {
    blockFeedInOnNegativePrices: settings.blockFeedInOnNegativePrices !== false,
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

  const rebalanceWindow = extractRebalanceWindow(
    result.Columns ?? {},
    cfg.rebalanceRemainingSlots ?? 0,
  );

  lastPlan = { cfg, data, timing, result, rows: rowsWithDess, summary, rebalanceWindow };
  return lastPlan;
}

export async function writePlanToVictron(rows: PlanRowWithDess[]): Promise<void> {
  await setDynamicEssSchedule(rows, Math.min(DESS_SLOTS, rows.length));
}

export async function planAndMaybeWrite({
  updateData = false,
  writeToVictron = false,
} = {}): Promise<ComputePlanResult> {
  const result = await computePlan({ updateData });
  if (writeToVictron) {
    await writePlanToVictron(result.rows);
  }
  return result;
}
