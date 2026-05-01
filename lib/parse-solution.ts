import type { PlanRow, SolverConfig, EvChargeMode } from './types.ts';

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

interface ParseSolutionOpts {
  startMs: number;
  stepMin: number;
}

export function parseSolution(result: HighsSolution, cfg: SolverConfig, opts: ParseSolutionOpts): PlanRow[] {
  const T = cfg.load_W.length;

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

  const entries = Object.entries(result.Columns ?? {});

  for (const [name, col] of entries) {
    const t = parseIndex(name);
    if (t == null || t < 0 || t >= T) continue;
    const v = valueOf(col);

    if (name.startsWith("grid_to_load_")) g2l[t] = v;
    else if (name.startsWith("grid_to_battery_")) g2b[t] = v;
    else if (name.startsWith("pv_to_load_")) pv2l[t] = v;
    else if (name.startsWith("pv_to_battery_")) pv2b[t] = v;
    else if (name.startsWith("pv_to_grid_")) pv2g[t] = v;
    else if (name.startsWith("battery_to_load_")) b2l[t] = v;
    else if (name.startsWith("battery_to_grid_")) b2g[t] = v;
    else if (name.startsWith("soc_")) soc[t] = v;
    else if (name.startsWith("grid_to_ev_"))    g2ev[t]  = v;
    else if (name.startsWith("pv_to_ev_"))       pv2ev[t] = v;
    else if (name.startsWith("battery_to_ev_"))  b2ev[t]  = v;
    else if (name.startsWith("ev_soc_"))         evSoc[t] = v;
  }

  // --- 2. Build rows (flows, soc, etc.) ---
  const slotHours = opts.stepMin / 60;
  const rows: PlanRow[] = [];
  for (let t = 0; t < T; t++) {
    const imp = g2l[t] + g2b[t] + g2ev[t];
    const exp = pv2g[t] + b2g[t];
    const evW = g2ev[t] + pv2ev[t] + b2ev[t];
    const importCost = imp * slotHours / 1000 * cfg.importPrice[t];
    const exportCost = exp * slotHours / 1000 * cfg.exportPrice[t];

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
      ev_charge_mode: evChargeMode(g2ev[t], pv2ev[t], b2ev[t], cfg.ev?.evMinChargePower_W ?? 0, pv2b[t]),
      ev_soc_percent: (evSoc[t] / evCap) * 100,
    });
  }

  return rows;
}

// 1 W threshold avoids spurious mode classification from solver floating-point residuals
const EV_FLOW_THRESHOLD_W = 1;

function evChargeMode(g: number, pv: number, b: number, evMinPow_W: number, pv2b: number): EvChargeMode {
  const total = g + pv + b;
  if (total < EV_FLOW_THRESHOLD_W)                             return 'off';
  if (evMinPow_W > 0 && total <= evMinPow_W * 1.02)           return 'fixed';       // at minimum charge rate → set exact amps (even if battery tops up)
  if (b > EV_FLOW_THRESHOLD_W)                                 return 'max';         // battery above minimum rate → use all sources
  if (pv2b > EV_FLOW_THRESHOLD_W)                              return 'fixed';       // PV split with battery → respect solver allocation
  if (pv > EV_FLOW_THRESHOLD_W && g > EV_FLOW_THRESHOLD_W)   return 'solar_grid';  // PV + grid → track PV + grid headroom
  if (pv > EV_FLOW_THRESHOLD_W)                                return 'solar_only';  // PV only → track PV surplus
  return 'solar_grid';                                                                // grid only → track grid headroom
}

// --- helpers ---

function parseIndex(varName: string): number | null {
  const m = /_(\d+)$/.exec(varName);
  return m ? Number(m[1]) : null;
}

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
