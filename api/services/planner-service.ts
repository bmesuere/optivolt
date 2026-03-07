// @ts-ignore — no .d.ts alongside the vendor build artifact; type is asserted via HighsInstance below
import highsFactory from '../../vendor/highs-build/highs.js';
import { mapRowsToDessV2 } from '../../lib/dess-mapper.ts';
import { buildLP } from '../../lib/build-lp.ts';
import { parseSolution, type HighsSolution } from '../../lib/parse-solution.ts';
import { buildPlanSummary } from '../../lib/plan-summary.ts';
import { buildEvSchedule } from '../../lib/ev-schedule.ts';
import type { SolverConfig, PlanSummary, EvSlot } from '../../lib/types.ts';
import { getSolverInputs, buildSolverConfigFromSettings } from './config-builder.ts';
import { saveSettings } from './settings-store.ts';
import { saveData } from './data-store.ts';
import { refreshSeriesFromVrmAndPersist } from './vrm-refresh.ts';
import { setDynamicEssSchedule } from './mqtt-service.ts';
import type { PlanRowWithDess, Data } from '../types.ts';

// How many slots we push into Dynamic ESS
const DESS_SLOTS = 4;

let latestEvSchedule: EvSlot[] | null = null;

export function getLatestEvSchedule(): EvSlot[] | null {
  return latestEvSchedule;
}

export function getCurrentEvSlot(): EvSlot | null {
  if (!latestEvSchedule) return null;
  const now = Date.now();
  let current: EvSlot | null = null;
  for (const slot of latestEvSchedule) {
    if (slot.timestampMs <= now) current = slot;
    else break;
  }
  return current;
}

// Single-phase mains voltage used to convert EV charge current (A) to power (W)
const MAINS_VOLTAGE_V = 230;

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
  evSchedule: EvSlot[];
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
    cfg = buildSolverConfigFromSettings(settings, data, timing.startMs);
  }

  const lpText = buildLP(cfg);
  const highs = await getHighsInstance();
  let result: ReturnType<typeof highs.solve>;
  try {
    result = highs.solve(lpText);
  } catch (err) {
    highsPromise = undefined; // force re-initialisation on next call
    throw err;
  }

  const rows = parseSolution(result, cfg, timing);

  const { perSlot, diagnostics } = mapRowsToDessV2(rows, cfg);

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

  latestEvSchedule = buildEvSchedule(rows, {
    evEnabled: settings.evEnabled,
    plugged: data.evState?.plugged ?? false,
    chargePower_W: settings.evChargeCurrent_A * MAINS_VOLTAGE_V,
  });

  return { cfg, data, timing, result, rows: rowsWithDess, summary, evSchedule: latestEvSchedule, rebalanceWindow };
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
