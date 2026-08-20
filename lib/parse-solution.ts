import type { PlanRow, SolverConfig, EvChargeMode } from './types.ts';
import { lpVar } from './lp-vars.ts';

const EV_CHARGE_VOLTAGE_V = 230; // single-phase AC voltage assumed for A conversion

// Minimal type for the HiGHS solver result columns (keyed by variable name).
interface HighsColumn {
  Primal?: number;
}

export interface HighsSolution {
  Status?: string;
  ObjectiveValue?: number;
  Columns?: Record<string, HighsColumn>;
}

// Statuses that can carry a feasible primal solution: "Optimal", plus early
// stops whose incumbent is still worth displaying (planner-service separately
// refuses hardware writes for anything non-Optimal).
const STATUSES_WITH_SOLUTION = new Set([
  'Optimal',
  'Time limit reached',
  'Iteration limit reached',
  'Bound on objective reached',
  'Target for objective reached',
]);

/** Thrown when a HiGHS result carries no usable primal solution. */
export class SolverStatusError extends Error {
  status: string;

  constructor(status: string, message = `Solver produced no usable solution: status is "${status}"`) {
    super(message);
    this.name = 'SolverStatusError';
    this.status = status;
  }
}

// An early stop can happen before any incumbent is found; the status alone is
// not proof of a solution. Require the always-present soc_* columns to exist
// with finite primal values before trusting the result.
function hasUsablePrimal(result: HighsSolution, T: number): boolean {
  const columns = result.Columns ?? {};
  for (let t = 0; t < T; t++) {
    const primal = columns[lpVar.soc.name(t)]?.Primal;
    if (primal == null || !Number.isFinite(primal)) return false;
  }
  return true;
}

interface ParseSolutionOpts {
  startMs: number;
  stepMin: number;
}

export function parseSolution(result: HighsSolution, cfg: SolverConfig, opts: ParseSolutionOpts): PlanRow[] {
  if (!STATUSES_WITH_SOLUTION.has(result.Status ?? '')) {
    throw new SolverStatusError(result.Status ?? 'missing');
  }

  const T = cfg.load_W.length;

  if (result.Status !== 'Optimal' && !hasUsablePrimal(result, T)) {
    throw new SolverStatusError(
      result.Status ?? 'missing',
      `Solver stopped early without a feasible incumbent: status is "${result.Status}"`,
    );
  }

  const timestampsMs = synthesizeFromStart(opts.startMs, opts.stepMin, T);

  const cap = Math.max(1e-9, cfg.batteryCapacity_Wh);
  const evCap = Math.max(1e-9, cfg.ev?.evBatteryCapacity_Wh ?? 1);

  // --- 1. Reconstruct solver columns into per-slot arrays ---
  const g2l = Array(T).fill(0);
  const g2b = Array(T).fill(0);
  const pv2l = Array(T).fill(0);
  const pv2b = Array(T).fill(0);
  const pv2g = Array(T).fill(0);
  const b2l = Array(T).fill(0);
  const b2g = Array(T).fill(0);
  const soc = Array(T).fill(0);
  const g2ev  = Array(T).fill(0);
  const pv2ev = Array(T).fill(0);
  const b2ev  = Array(T).fill(0);
  const evSoc = Array(T).fill(0);

  // Family parse() matches `<prefix>_<digits>` exactly, so overlapping
  // prefixes (soc_3 vs soc_shortfall_3) cannot collide.
  const familyTargets: Array<[{ parse(name: string): number | null }, number[]]> = [
    [lpVar.gridToLoad, g2l],
    [lpVar.gridToBattery, g2b],
    [lpVar.pvToLoad, pv2l],
    [lpVar.pvToBattery, pv2b],
    [lpVar.pvToGrid, pv2g],
    [lpVar.batteryToLoad, b2l],
    [lpVar.batteryToGrid, b2g],
    [lpVar.soc, soc],
    [lpVar.gridToEv, g2ev],
    [lpVar.pvToEv, pv2ev],
    [lpVar.batteryToEv, b2ev],
    [lpVar.evSoc, evSoc],
  ];

  for (const [name, col] of Object.entries(result.Columns ?? {})) {
    for (const [family, target] of familyTargets) {
      const t = family.parse(name);
      if (t == null) continue;
      if (t < T) target[t] = valueOf(col);
      break;
    }
  }

  // --- 2. Build rows (flows, soc, etc.) ---
  // Resolved EV SoC deadlines, by the slot they are pinned at, so consumers read
  // the target the LP actually enforced instead of re-deriving it from settings.
  // ev-config-builder already de-dupes per slot; keeping the higher requirement
  // here makes that independent of the caller.
  const evTargetWhBySlot = new Map<number, number>();
  for (const target of cfg.ev?.targets ?? []) {
    evTargetWhBySlot.set(target.slot, Math.max(evTargetWhBySlot.get(target.slot) ?? 0, target.soc_Wh));
  }

  const slotHours = opts.stepMin / 60;
  const rows: PlanRow[] = [];
  for (let t = 0; t < T; t++) {
    const imp = g2l[t] + g2b[t] + g2ev[t];
    const exp = pv2g[t] + b2g[t];
    const evW = g2ev[t] + pv2ev[t] + b2ev[t];
    const importCost = imp * slotHours / 1000 * cfg.importPrice[t];
    const exportCost = exp * slotHours / 1000 * cfg.exportPrice[t];
    const evTargetWh = evTargetWhBySlot.get(t);

    rows.push({
      tIdx: t,
      timestampMs: timestampsMs[t],

      load: round(cfg.load_W[t]),
      pv: round(cfg.pv_W[t]),
      ic: cfg.importPrice[t],
      ec: cfg.exportPrice[t],

      g2l: round(g2l[t]),
      g2b: round(g2b[t]),
      pv2l: round(pv2l[t]),
      pv2b: round(pv2b[t]),
      pv2g: round(pv2g[t]),
      b2l: round(b2l[t]),
      b2g: round(b2g[t]),

      imp: round(imp),
      exp: round(exp),
      importCost_cents: round(importCost),
      exportCost_cents: round(exportCost),
      soc: round(soc[t]),
      soc_percent: (soc[t] / cap) * 100,
      g2ev:          round(g2ev[t]),
      pv2ev:         round(pv2ev[t]),
      b2ev:          round(b2ev[t]),
      ev_charge:     round(evW),
      ev_charge_A:   round(evW / EV_CHARGE_VOLTAGE_V),
      ev_charge_mode: evChargeMode(
        g2ev[t],
        pv2ev[t],
        b2ev[t],
        cfg.ev?.evMinChargePower_W ?? 0,
        cfg.ev?.evMaxChargePower_W ?? 0,
        pv2b[t],
      ),
      ev_soc_percent: (evSoc[t] / evCap) * 100,
      ...(evTargetWh != null ? { ev_target_soc_percent: (evTargetWh / evCap) * 100 } : {}),
    });
  }

  return rows;
}

// 1 W threshold avoids spurious mode classification from solver floating-point residuals
const EV_FLOW_THRESHOLD_W = 1;

function evChargeMode(g: number, pv: number, b: number, evMinPow_W: number, evMaxPow_W: number, pv2b: number): EvChargeMode {
  const total = g + pv + b;
  if (total < EV_FLOW_THRESHOLD_W)                             return 'off';
  if (evMinPow_W > 0 && total <= evMinPow_W * 1.02)           return 'fixed';       // at minimum charge rate → set exact amps (even if battery tops up)
  if (b > EV_FLOW_THRESHOLD_W) {
    if (evMaxPow_W > 0 && total >= evMaxPow_W * 0.98)          return 'max';         // charger is at its configured maximum current
    return 'fixed';                                                                  // target- or source-limited battery assist → set exact planned amps
  }
  if (pv2b > EV_FLOW_THRESHOLD_W)                              return 'fixed';       // PV split with battery → respect solver allocation
  if (pv > EV_FLOW_THRESHOLD_W && g > EV_FLOW_THRESHOLD_W)   return 'solar_grid';  // PV + grid → track PV + grid headroom
  if (pv > EV_FLOW_THRESHOLD_W)                                return 'solar_only';  // PV only → track PV surplus
  return 'solar_grid';                                                                // grid only → track grid headroom
}

// --- helpers ---

function valueOf(col: HighsColumn): number {
  return col.Primal ?? 0;
}

function round(x: number): number {
  return Math.abs(x) < 1e-9 ? 0 : Math.round(x * 1000) / 1000;
}

// synthesize timeline from a provided startMs
function synthesizeFromStart(startMs: number, stepMin: number, T: number): number[] {
  const out = new Array<number>(T);
  const stepMs = stepMin * 60_000;
  for (let i = 0; i < T; i++) {
    out[i] = startMs + i * stepMs;
  }
  return out;
}
