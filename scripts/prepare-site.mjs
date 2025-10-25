// scripts/prepare-site.mjs
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const srcDir = path.join(root, "src");
const dstDir = path.join(root, "docs", "lib");

// Files we want available to the browser UI
const files = [
  "build-lp.js",
  "parse-solution.js",
  "vrm-api.js"
];

fs.mkdirSync(dstDir, { recursive: true });

let copied = 0;
for (const f of files) {
  const from = path.join(srcDir, f);
  const to = path.join(dstDir, f);
  try {
    fs.copyFileSync(from, to);
    copied++;
  } catch (err) {
    console.error(`Failed to copy ${f}: ${err.message}`);
    process.exitCode = 1;
  }
}

console.log(`Prepared site: copied ${copied}/${files.length} file(s) to docs/lib`);
