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

    els.objective.textContent = Number.isFinite(result.ObjectiveValue)
      ? String(Number.parseFloat(result.ObjectiveValue).toFixed(2))  // round to whole c€
      : "—";
    els.status.textContent = `Status: ${result.Status}`;

    const { rows } = parseSolution(result, cfg);
    renderTable(rows, cfg);

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

function renderTable(rows, cfg) {
  const cap = Math.max(1e-9, Number(cfg?.batteryCapacity_Wh ?? 20480));

  // columns: key, header, formatter
  const cols = [
    { key: "t", header: "t", fmt: v => v },
    { key: "load", header: "load", fmt: intThin },
    { key: "pv", header: "pv", fmt: intThin },

    { key: "ic", header: "ic", fmt: dec2Thin },
    { key: "ec", header: "ec", fmt: dec2Thin },

    { key: "g2l", header: "g2l", fmt: intThin },
    { key: "g2b", header: "g2b", fmt: intThin },
    { key: "pv2l", header: "pv2l", fmt: intThin },
    { key: "pv2b", header: "pv2b", fmt: intThin },
    { key: "pv2g", header: "pv2g", fmt: intThin },
    { key: "b2l", header: "b2l", fmt: intThin },
    { key: "b2g", header: "b2g", fmt: intThin },

    { key: "imp", header: "imp", fmt: intThin },
    { key: "exp", header: "exp", fmt: intThin },

    { key: "soc", header: "soc", fmt: (w) => pct0(w / cap) + "%" },
  ];

  const thead = `
    <thead>
      <tr>
        ${cols.map(c => `<th class="px-2 py-1 border-b font-medium text-right">${escapeHtml(c.header)}</th>`).join("")}
      </tr>
    </thead>`;

  const tbody = `
    <tbody>
      ${rows.map(r => `
        <tr>
          ${cols.map(c => `<td class="px-2 py-1 border-b text-right font-mono tabular-nums">${c.fmt(r[c.key])}</td>`).join("")}
        </tr>`).join("")}
    </tbody>`;

  document.querySelector("#table").innerHTML = thead + tbody;

  // --- helpers ---

  // thin-space thousands for integers
  function intThin(x) {
    const n = Math.round(Number(x) || 0);
    return groupThin(n);
  }

  // thin-space thousands with exactly 2 decimals
  function dec2Thin(x) {
    const n = Number(x);
    if (!Number.isFinite(n)) return "";
    const s = n.toFixed(2);
    const [i, f] = s.split(".");
    return `${groupThin(i)}.${f}`;
  }

  // % with 0 decimals
  function pct0(x) {
    const n = (Number(x) || 0) * 100;
    return groupThin(Math.round(n));
  }

  // insert thin spaces as thousands separators
  function groupThin(numOrStr) {
    const s = String(numOrStr);
    // support negative numbers
    const neg = s.startsWith("-") ? "-" : "";
    const body = neg ? s.slice(1) : s;
    // split integer/decimal if present
    const parts = body.split(".");
    const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009"); // U+2009 thin space
    return parts.length > 1 ? `${neg}${intPart}.${parts[1]}` : `${neg}${intPart}`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
  }
}
