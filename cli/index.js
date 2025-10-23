import fs from "node:fs";
import process from "node:process";
import highsFactory from "highs";

import { buildLP } from "../src/build-lp.js";
import { parseSolution } from "../src/parse-solution.js";

/**
 * Usage:
 *   npm run dev # solves examples/day.json
 *   npm run solve -- examples/day.json
 */
async function main() {
  const cfg = JSON.parse(fs.readFileSync(process.argv[2] || "examples/day.json", "utf8"));
  const lpText = buildLP(cfg);
  console.log(lpText);

  const highs = await highsFactory({});
  const result = highs.solve(lpText);

  console.log("Status:", result.Status);
  console.log("Objective:", result.ObjectiveValue);

  const { rows } = parseSolution(result, cfg);
  console.table(rows);
}

main().catch(err => { console.error(err); process.exit(1); });
