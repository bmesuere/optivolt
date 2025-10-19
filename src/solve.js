import fs from "node:fs";
import process from "node:process";
import highsFactory from "highs";

import { buildLP } from "./build-lp.js";

/**
 * Usage:
 *   npm run dev # solves examples/day.json
 *   npm run solve -- examples/day.json
 */
async function main() {
  const cfg = JSON.parse(fs.readFileSync(process.argv[2] || "examples/day.json", "utf8"));
  const lpText = buildLP(cfg);
  console.log(lpText);

  const highs = await highsFactory({
    // In browser builds, use locateFile. In Node, defaults are fine.
  });

  const result = highs.solve(lpText);

  console.log("Status:", result.Status);
  console.log("Objective:", result.ObjectiveValue);

  printScheduleTable(result, cfg)
}

function valueOf(col) {
  return (typeof col === "number") ? col : (col?.Value ?? col?.Primal ?? col?.PrimalValue ?? 0);
}

function printScheduleTable(result, cfg) {
  const T = cfg.load_W.length;

  // Buckets for decision variables (fill with zeros)
  const gridImport = Array(T).fill(0);
  const gridExport = Array(T).fill(0);
  const batteryCharge = Array(T).fill(0);
  const batteryDischarge = Array(T).fill(0);
  const soc = Array(T).fill(0);

  // Parse the Columns map (only map/object format supported)
  for (const [varName, col] of Object.entries(result.Columns || {})) {
    const m = /(grid_import|grid_export|bat_charge|bat_discharge|soc)_(\d+)$/.exec(varName);
    if (!m) continue;
    const kind = m[1];
    const t = Number(m[2]);
    if (Number.isNaN(t) || t < 0 || t >= T) continue;

    const val = valueOf(col);
    switch (kind) {
      case "grid_import": gridImport[t] = val; break;
      case "grid_export": gridExport[t] = val; break;
      case "bat_charge": batteryCharge[t] = val; break;
      case "bat_discharge": batteryDischarge[t] = val; break;
      case "soc": soc[t] = val; break;
    }
  }

  // Build rows: label + t0..t{T-1}
  const rows = [];
  const addRow = (label, arr) => {
    const row = { Metric: label };
    for (let t = 0; t < T; t++) row[`t${t}`] = arr[t] ?? 0;
    rows.push(row);
  };

  addRow("load (W)", cfg.load_W);
  addRow("import price (c€/kWh)", cfg.importPrice);
  addRow("export price (c€/kWh)", cfg.exportPrice);
  addRow("grid import (W)", gridImport);
  addRow("grid export (W)", gridExport);
  addRow("battery charge (W)", batteryCharge);
  addRow("battery discharge (W)", batteryDischarge);
  addRow("state of charge (Wh)", soc);

  console.table(rows);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
