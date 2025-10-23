export function parseSolution(result, cfg) {
  const T = cfg.load_W.length;

  const g2l = Array(T).fill(0);
  const g2b = Array(T).fill(0);
  const pv2l = Array(T).fill(0);
  const pv2b = Array(T).fill(0);
  const pv2g = Array(T).fill(0);
  const b2l = Array(T).fill(0);
  const b2g = Array(T).fill(0);
  const soc = Array(T).fill(0);

  const cols = result.Columns || [];
  const entries = Array.isArray(cols) ? cols.map(c => [c.Name, c]) : Object.entries(cols);

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

    // Back-compat with early names
    else if (name.startsWith("grid_import_")) g2l[t] += v;
    else if (name.startsWith("grid_export_")) pv2g[t] += v;
    else if (name.startsWith("bat_charge_")) g2b[t] += v;
    else if (name.startsWith("bat_discharge_")) b2l[t] += v;
  }

  const rows = [];
  for (let t = 0; t < T; t++) {
    const ic = cfg.importPrice?.[t] ?? null;
    const ec = cfg.exportPrice?.[t] ?? null;
    const pv = cfg.pv_W?.[t] ?? 0;
    const imp = g2l[t] + g2b[t];
    const exp = pv2g[t] + b2g[t];

    rows.push({
      t,
      load: round(cfg.load_W[t]),
      pv: round(pv),
      ic, ec,
      g2l: round(g2l[t]),
      g2b: round(g2b[t]),
      pv2l: round(pv2l[t]),
      pv2b: round(pv2b[t]),
      pv2g: round(pv2g[t]),
      b2l: round(b2l[t]),
      b2g: round(b2g[t]),
      imp: round(imp),
      exp: round(exp),
      soc: round(soc[t])
    });
  }

  return { rows, series: { g2l, g2b, pv2l, pv2b, pv2g, b2l, b2g, soc } };
}

function parseIndex(varName) {
  const m = /_(\d+)$/.exec(varName);
  return m ? Number(m[1]) : null;
}
function valueOf(col) {
  if (col == null) return 0;
  if (typeof col === "number") return col;
  if (typeof col.Value === "number") return col.Value;
  if (typeof col.Primal === "number") return col.Primal;
  if (typeof col.value === "number") return col.value;
  return Number(col) || 0;
}
function round(x) {
  return Math.abs(x) < 1e-9 ? 0 : Math.round(x * 1000) / 1000;
}
