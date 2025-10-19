import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import highsFactory from "highs";

/**
 * Usage:
 *   npm run dev # solves examples/demo.lp
 *   npm run solve -- examples/demo.lp
 */
async function main() {
  const lpPath = process.argv[2] || "examples/demo.lp";
  const abs = path.resolve(lpPath);
  if (!fs.existsSync(abs)) {
    console.error(`LP file not found: ${abs}`);
    process.exit(1);
  }

  const lp = fs.readFileSync(abs, "utf8");

  const highs = await highsFactory({
    // In browser builds, use locateFile. In Node, defaults are fine.
  });

  const result = highs.solve(lp);

  console.log("Status:", result.Status);
  console.log("Objective:", result.ObjectiveValue);

  // Pretty-print columns
  for (const [name, col] of Object.entries(result.Columns)) {
    const val = (typeof col === "number") ? col : (col?.Value ?? col?.Primal ?? col?.PrimalValue ?? 0);
    console.log(`${name} = ${val}`);
  }

  // Rows have duals/slacks if you care:
  for (const row of result.Rows || []) console.log(row.Name, row.Dual, row.Primal);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
