import type { PlanRow, SolverConfig } from './types.ts';

// Minimal type for the HiGHS solver result columns.
// HiGHS can return columns as either an array (with a Name field) or an object keyed by name.
interface HighsColumn {
  Name?: string;
  Value?: number;
  Primal?: number;
  value?: number;
}

export interface HighsSolution {
  Columns?: HighsColumn[] | Record<string, HighsColumn>;
}

interface ParseSolutionOpts {
  startMs: number;
  stepMin: number;
}

export function parseSolution(result: HighsSolution, cfg: SolverConfig, opts: ParseSolutionOpts): PlanRow[] {
  const T = cfg.load_W.length;

  const timestampsMs = synthesizeFromStart(opts.startMs, opts.stepMin, T);

  const cap = Math.max(1e-9, cfg.batteryCapacity_Wh);

  // --- 1. Reconstruct solver columns into per-slot arrays ---
  const g2l = Array(T).fill(0);
  const g2b = Array(T).fill(0);
  const pv2l = Array(T).fill(0);
  const pv2b = Array(T).fill(0);
  const pv2g = Array(T).fill(0);
  const b2l = Array(T).fill(0);
  const b2g = Array(T).fill(0);
  const soc = Array(T).fill(0);

  const cols = result.Columns || [];
  const entries: [string, HighsColumn][] = Array.isArray(cols)
    ? cols.map(c => [c.Name ?? '', c])
    : Object.entries(cols);

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

    // backwards-compatible names
    else if (name.startsWith("grid_import_")) g2l[t] += v;
    else if (name.startsWith("grid_export_")) pv2g[t] += v;
    else if (name.startsWith("bat_charge_")) g2b[t] += v;
    else if (name.startsWith("bat_discharge_")) b2l[t] += v;
  }

  // --- 2. Build rows (flows, soc, etc.) ---
  const rows: PlanRow[] = [];
  for (let t = 0; t < T; t++) {
    const imp = g2l[t] + g2b[t];
    const exp = pv2g[t] + b2g[t];

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
      soc: round(soc[t]),
      soc_percent: (soc[t] / cap) * 100,
    });
  }

  return rows;
}

// --- helpers ---

function parseIndex(varName: string): number | null {
  const m = /_(\d+)$/.exec(varName);
  return m ? Number(m[1]) : null;
}

function valueOf(col: HighsColumn): number {
  if (col == null) return 0;
  if (typeof col.Value === "number") return col.Value;
  if (typeof col.Primal === "number") return col.Primal;
  if (typeof col.value === "number") return col.value;
  return 0;
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
