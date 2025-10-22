// Import shared logic (copied by prepare script)
import { buildLP } from "./lib/build-lp.js";
import { parseSolution } from "./lib/parse-solution.js";
import { drawFlowsBarStackSigned, drawSocChart, drawPricesStepLines, drawLoadPvGrouped } from "./charts.js";

const $ = (sel) => document.querySelector(sel);
const els = {
  file: $("#file"),
  run: $("#run"),
  step: $("#step"), cap: $("#cap"),
  minsoc: $("#minsoc"), maxsoc: $("#maxsoc"), initsoc: $("#initsoc"),
  pchg: $("#pchg"), pdis: $("#pdis"),
  gimp: $("#gimp"), gexp: $("#gexp"),
  etaC: $("#etaC"), etaD: $("#etaD"),
  bwear: $("#bwear"), terminal: $("#terminal"),
  tLoad: $("#ts-load"), tPV: $("#ts-pv"), tIC: $("#ts-ic"), tEC: $("#ts-ec"),
  status: $("#status"), objective: $("#objective"),
  flows: $("#flows"), prices: $("#prices"), loadpv: $("#loadpv"),
  soc: $("#soc"),
  table: $("#table"),
};

let highs = null;

// --- simple debounce for auto-run ---
let timer = null;
const debounceRun = () => {
  clearTimeout(timer);
  timer = setTimeout(onRun, 250); // run 250ms after last change
};

boot();

async function boot() {
  // Optional JSON import
  els.file?.addEventListener("change", onFile);

  // “Run” button still works, but we also auto-run on input changes
  els.run?.addEventListener("click", onRun);

  // Auto-run whenever something changes (inputs, selects, textareas)
  for (const el of document.querySelectorAll("input, select, textarea")) {
    el.addEventListener("input", debounceRun);
    el.addEventListener("change", debounceRun);
  }

  // Initialize HiGHS via global UMD factory `Module`
  // eslint-disable-next-line no-undef
  highs = await Module({
    locateFile: (file) => "https://lovasoa.github.io/highs-js/" + file
  });
  els.status.textContent = "Solver loaded.";

  // Auto-run once with defaults in fields
  await onRun();
}

async function onFile(e) {
  const f = e.target.files?.[0];
  if (!f) return;
  const text = await f.text();
  try {
    const cfg = JSON.parse(text);
    // Push JSON values into fields if present
    setIfPresent(els.step, cfg.stepSize_m);
    setIfPresent(els.cap, cfg.batteryCapacity_Wh);
    setIfPresent(els.minsoc, cfg.minSoc_percent);
    setIfPresent(els.maxsoc, cfg.maxSoc_percent);
    setIfPresent(els.initsoc, cfg.initialSoc_percent);
    setIfPresent(els.pchg, cfg.maxChargePower_W);
    setIfPresent(els.pdis, cfg.maxDischargePower_W);
    setIfPresent(els.gimp, cfg.maxGridImport_W);
    setIfPresent(els.gexp, cfg.maxGridExport_W);
    setIfPresent(els.etaC, cfg.chargeEfficiency_percent);
    setIfPresent(els.etaD, cfg.dischargeEfficiency_percent);
    setIfPresent(els.bwear, cfg.batteryCost_cent_per_kWh);
    if (cfg.terminalSocValuation) els.terminal.value = cfg.terminalSocValuation;

    if (Array.isArray(cfg.load_W)) els.tLoad.value = cfg.load_W.join(",");
    if (Array.isArray(cfg.pv_W)) els.tPV.value = cfg.pv_W.join(",");
    if (Array.isArray(cfg.importPrice)) els.tIC.value = cfg.importPrice.join(",");
    if (Array.isArray(cfg.exportPrice)) els.tEC.value = cfg.exportPrice.join(",");

    els.status.textContent = "Config loaded from JSON. Running…";
    await onRun();
  } catch (err) {
    console.error(err);
    els.status.textContent = `Error parsing JSON: ${err.message}`;
  }
}

function setIfPresent(input, v) { if (v != null) input.value = v; }

async function onRun() {
  try {
    const load_W = parseSeries(els.tLoad.value);
    const pv_W = parseSeries(els.tPV.value);
    const importPrice = parseSeries(els.tIC.value);
    const exportPrice = parseSeries(els.tEC.value);

    const T = Math.min(load_W.length, pv_W.length, importPrice.length, exportPrice.length);
    if (T === 0) throw new Error("No data in time series.");
    const clip = (a) => a.slice(0, T);

    const cfg = {
      load_W: clip(load_W),
      pv_W: clip(pv_W),
      importPrice: clip(importPrice),
      exportPrice: clip(exportPrice),

      stepSize_m: num(els.step.value, 15),
      batteryCapacity_Wh: num(els.cap.value, 20480),
      minSoc_percent: num(els.minsoc.value, 20),
      maxSoc_percent: num(els.maxsoc.value, 100),
      initialSoc_percent: num(els.initsoc.value, 20),

      maxChargePower_W: num(els.pchg.value, 3600),
      maxDischargePower_W: num(els.pdis.value, 4000),
      maxGridImport_W: num(els.gimp.value, 2500),
      maxGridExport_W: num(els.gexp.value, 5000),
      chargeEfficiency_percent: num(els.etaC.value, 95),
      dischargeEfficiency_percent: num(els.etaD.value, 95),
      batteryCost_cent_per_kWh: num(els.bwear.value, 2),
      terminalSocValuation: els.terminal.value || "zero",
    };

    const lpText = buildLP(cfg);
    const result = highs.solve(lpText);

    els.objective.textContent = `${fmtNum(result.ObjectiveValue)}`;
    els.status.textContent = `Status: ${result.Status}`;

    const { rows } = parseSolution(result, cfg);
    renderTable(rows);

    // Charts
    drawFlowsBarStackSigned(els.flows, rows, cfg.stepSize_m);                   // kWh stacks (no SoC overlay)
    drawSocChart(els.soc, rows, cfg.batteryCapacity_Wh);                        // separate SoC chart (%)
    drawPricesStepLines(els.prices, rows);                                      // Buy/Sell (step)
    drawLoadPvGrouped(els.loadpv, rows, cfg.stepSize_m);                        // kWh grouped forecast
  } catch (err) {
    console.error(err);
    els.status.textContent = `Error: ${err.message}`;
  }
}

function parseSeries(s) {
  return (s || "")
    .split(/[\s,]+/)
    .map(Number)
    .filter((x) => Number.isFinite(x));
}

function num(val, fallback) { const n = Number(val); return Number.isFinite(n) ? n : fallback; }
function fmtNum(x) { if (x == null || !isFinite(x)) return "—"; const f = Number(x); return Math.abs(f) < 1e-6 ? "0" : f.toFixed(4); }

function renderTable(rows) {
  const headers = ["t", "load", "pv", "ic", "ec", "g2l", "g2b", "pv2l", "pv2b", "pv2g", "b2l", "b2g", "imp", "exp", "soc"];
  const thead = `<thead><tr class="text-left">${headers.map(h => `<th class="px-2 py-1 border-b">${h}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows.map(r =>
    `<tr>${headers.map(h => `<td class="px-2 py-1 border-b">${r[h] ?? ""}</td>`).join("")}</tr>`
  ).join("")}</tbody>`;
  document.querySelector("#table").innerHTML = thead + tbody;
}
