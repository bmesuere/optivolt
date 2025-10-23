// Import shared logic
import { buildLP } from "./lib/build-lp.js";
import { parseSolution } from "./lib/parse-solution.js";
import { drawFlowsBarStackSigned, drawSocChart, drawPricesStepLines, drawLoadPvGrouped } from "./charts.js";

const STORAGE_KEY = "optivolt-config-v1";

// ---- Defaults (match your latest example) ----
const DEFAULTS = {
  stepSize_m: 60,
  batteryCapacity_Wh: 20480,
  minSoc_percent: 20,
  maxSoc_percent: 100,
  initialSoc_percent: 20,
  maxChargePower_W: 3600,
  maxDischargePower_W: 4000,
  maxGridImport_W: 2500,
  maxGridExport_W: 5000,
  chargeEfficiency_percent: 95,
  dischargeEfficiency_percent: 95,
  batteryCost_cent_per_kWh: 2,
  terminalSocValuation: "zero",
  tableShowKwh: false,

  load_W_txt: "280,250,360,420,1230,190,190,490,490,360,670,1750,340,640,360,880,650,900,540,500,480,480,480,290",
  pv_W_txt: "0,0,0,0,0,0,0,0,40,120,480,700,920,910,940,670,520,290,60,0,0,0,0,0",
  importPrice_txt: "22.258065600000002,21.642862800000003,21.0892884,21.10875,20.760603600000003,20.515171200000005,22.302394800000002,23.395488,23.527394400000006,29.488050000000005,27.600274800000005,24.1653024,23.696061600000004,23.5122576,22.264552800000004,22.5337716,21.789906000000002,22.3391556,29.704290000000004,44.90920560000001,33.8550168,28.9160952,25.5719436,23.5284756",
  exportPrice_txt: "6.45074,5.893119999999999,5.391359999999999,5.409,5.09344,4.870979999999999,6.49092,7.481700000000001,7.60126,13.004,11.292919999999999,8.179459999999999,7.754140000000001,7.58754,6.456619999999999,6.700640000000001,6.0264,6.524239999999999,13.200000000000001,26.98174,16.96222,12.48558,9.45444,7.602239999999999"
};

const $ = (sel) => document.querySelector(sel);
const els = {
  run: $("#run"),
  restore: $("#restore"),
  share: $("#share"),

  // numeric inputs
  step: $("#step"), cap: $("#cap"),
  minsoc: $("#minsoc"), maxsoc: $("#maxsoc"), initsoc: $("#initsoc"),
  pchg: $("#pchg"), pdis: $("#pdis"),
  gimp: $("#gimp"), gexp: $("#gexp"),
  etaC: $("#etaC"), etaD: $("#etaD"),
  bwear: $("#bwear"), terminal: $("#terminal"),

  // textareas
  tLoad: $("#ts-load"), tPV: $("#ts-pv"), tIC: $("#ts-ic"), tEC: $("#ts-ec"),

  // charts + status
  flows: $("#flows"), soc: $("#soc"), prices: $("#prices"), loadpv: $("#loadpv"),
  table: $("#table"),
  tableKwh: $("#table-kwh"),
  tableUnit: $("#table-unit"),
  status: $("#status"), objective: $("#objective"),
};

let highs = null;

// --- simple debounce for auto-run ---
let timer = null;
const debounceRun = () => {
  clearTimeout(timer);
  timer = setTimeout(onRun, 250);
};

// ---------- Boot ----------
boot();

async function boot() {
  // Hydrate UI from storage or defaults
  const urlCfg = decodeConfigFromQuery();
  hydrateUI(urlCfg || loadFromStorage() || DEFAULTS);

  // Auto-save whenever anything changes
  for (const el of document.querySelectorAll("input, select, textarea")) {
    el.addEventListener("input", () => { saveToStorage(snapshotUI()); debounceRun(); });
    el.addEventListener("change", () => { saveToStorage(snapshotUI()); debounceRun(); });
  }

  // Manual recompute
  els.run?.addEventListener("click", onRun);

  // Units toggle recompute
  els.tableKwh?.addEventListener("change", () => {
    saveToStorage(snapshotUI());
    onRun();
  });

  // Restore defaults
  els.restore?.addEventListener("click", () => {
    hydrateUI(DEFAULTS);
    saveToStorage(DEFAULTS);
    onRun();
  });

  // Share current config via URL (copied to clipboard)
  els.share?.addEventListener("click", async () => {
    try {
      const link = encodeConfigToQuery(snapshotUI());
      await navigator.clipboard.writeText(link);
      // tiny visual ack
      const prev = els.share.textContent;
      els.share.textContent = "Copied!";
      setTimeout(() => (els.share.textContent = prev), 1200);
    } catch {
      // fallback: open in a new tab
      window.open(encodeConfigToQuery(snapshotUI()), "_blank");
    }
  });

  // Initialize HiGHS via global UMD factory `Module`
  // eslint-disable-next-line no-undef
  highs = await Module({
    locateFile: (file) => "https://lovasoa.github.io/highs-js/" + file
  });
  els.status.textContent = "Solver loaded.";

  // Initial compute
  await onRun();
}

// ---------- Storage helpers ----------
function saveToStorage(obj) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(obj)); } catch { }
}
function loadFromStorage() {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}
// --- URL share helpers (URL-safe base64 of the snapshot JSON) ---
function encodeConfigToQuery(obj) {
  const json = JSON.stringify(obj);
  const b64 = btoa(unescape(encodeURIComponent(json))); // safe for non-ASCII
  const urlSafe = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const u = new URL(location.href);
  u.searchParams.set("cfg", urlSafe);
  return u.toString();
}
function decodeConfigFromQuery() {
  const u = new URL(location.href);
  const cfg = u.searchParams.get("cfg");
  if (!cfg) return null;
  try {
    const b64 = cfg.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(escape(atob(b64))); // inverse of above
    return JSON.parse(json);
  } catch {
    return null;
  }
}


// Take current UI and return a plain object (including textarea strings)
function snapshotUI() {
  return {
    stepSize_m: num(els.step.value, DEFAULTS.stepSize_m),
    batteryCapacity_Wh: num(els.cap.value, DEFAULTS.batteryCapacity_Wh),
    minSoc_percent: num(els.minsoc.value, DEFAULTS.minSoc_percent),
    maxSoc_percent: num(els.maxsoc.value, DEFAULTS.maxSoc_percent),
    initialSoc_percent: num(els.initsoc.value, DEFAULTS.initialSoc_percent),
    maxChargePower_W: num(els.pchg.value, DEFAULTS.maxChargePower_W),
    maxDischargePower_W: num(els.pdis.value, DEFAULTS.maxDischargePower_W),
    maxGridImport_W: num(els.gimp.value, DEFAULTS.maxGridImport_W),
    maxGridExport_W: num(els.gexp.value, DEFAULTS.maxGridExport_W),
    chargeEfficiency_percent: num(els.etaC.value, DEFAULTS.chargeEfficiency_percent),
    dischargeEfficiency_percent: num(els.etaD.value, DEFAULTS.dischargeEfficiency_percent),
    batteryCost_cent_per_kWh: num(els.bwear.value, DEFAULTS.batteryCost_cent_per_kWh),
    terminalSocValuation: els.terminal.value || DEFAULTS.terminalSocValuation,

    load_W_txt: els.tLoad.value,
    pv_W_txt: els.tPV.value,
    importPrice_txt: els.tIC.value,
    exportPrice_txt: els.tEC.value,
    tableShowKwh: !!els.tableKwh?.checked,
  };
}

// Write an object into the UI (numbers + textarea strings)
function hydrateUI(obj) {
  els.step.value = obj.stepSize_m ?? DEFAULTS.stepSize_m;
  els.cap.value = obj.batteryCapacity_Wh ?? DEFAULTS.batteryCapacity_Wh;
  els.minsoc.value = obj.minSoc_percent ?? DEFAULTS.minSoc_percent;
  els.maxsoc.value = obj.maxSoc_percent ?? DEFAULTS.maxSoc_percent;
  els.initsoc.value = obj.initialSoc_percent ?? DEFAULTS.initialSoc_percent;

  els.pchg.value = obj.maxChargePower_W ?? DEFAULTS.maxChargePower_W;
  els.pdis.value = obj.maxDischargePower_W ?? DEFAULTS.maxDischargePower_W;
  els.gimp.value = obj.maxGridImport_W ?? DEFAULTS.maxGridImport_W;
  els.gexp.value = obj.maxGridExport_W ?? DEFAULTS.maxGridExport_W;

  els.etaC.value = obj.chargeEfficiency_percent ?? DEFAULTS.chargeEfficiency_percent;
  els.etaD.value = obj.dischargeEfficiency_percent ?? DEFAULTS.dischargeEfficiency_percent;

  els.bwear.value = obj.batteryCost_cent_per_kWh ?? DEFAULTS.batteryCost_cent_per_kWh;
  els.terminal.value = obj.terminalSocValuation ?? DEFAULTS.terminalSocValuation;

  els.tLoad.value = obj.load_W_txt ?? DEFAULTS.load_W_txt;
  els.tPV.value = obj.pv_W_txt ?? DEFAULTS.pv_W_txt;
  els.tIC.value = obj.importPrice_txt ?? DEFAULTS.importPrice_txt;
  els.tEC.value = obj.exportPrice_txt ?? DEFAULTS.exportPrice_txt;
  if (els.tableKwh) els.tableKwh.checked = !!(obj.tableShowKwh ?? DEFAULTS.tableShowKwh);
}

// ---------- Main compute ----------
async function onRun() {
  try {
    const cfg = uiToConfig();
    const lpText = buildLP(cfg);

    // keep a copy in storage whenever we run
    saveToStorage(snapshotUI());

    const result = highs.solve(lpText);

    els.objective.textContent = Number.isFinite(result.ObjectiveValue)
      ? Number(result.ObjectiveValue).toFixed(2)
      : "—";
    els.status.textContent = `Status: ${result.Status}`;

    const { rows } = parseSolution(result, cfg);
    renderTable(rows, cfg, !!els.tableKwh?.checked);

    // Charts
    drawFlowsBarStackSigned(els.flows, rows, cfg.stepSize_m);
    drawSocChart(els.soc, rows, cfg.batteryCapacity_Wh);
    drawPricesStepLines(els.prices, rows);
    drawLoadPvGrouped(els.loadpv, rows, cfg.stepSize_m);
  } catch (err) {
    console.error(err);
    els.status.textContent = `Error: ${err.message}`;
  }
}

function uiToConfig() {
  const load_W = parseSeries(els.tLoad.value);
  const pv_W = parseSeries(els.tPV.value);
  const importPrice = parseSeries(els.tIC.value);
  const exportPrice = parseSeries(els.tEC.value);

  const T = Math.min(load_W.length, pv_W.length, importPrice.length, exportPrice.length);
  if (T === 0) throw new Error("No data in time series.");
  const clip = (a) => a.slice(0, T);

  return {
    load_W: clip(load_W),
    pv_W: clip(pv_W),
    importPrice: clip(importPrice),
    exportPrice: clip(exportPrice),

    stepSize_m: num(els.step.value, DEFAULTS.stepSize_m),
    batteryCapacity_Wh: num(els.cap.value, DEFAULTS.batteryCapacity_Wh),
    minSoc_percent: num(els.minsoc.value, DEFAULTS.minSoc_percent),
    maxSoc_percent: num(els.maxsoc.value, DEFAULTS.maxSoc_percent),
    initialSoc_percent: num(els.initsoc.value, DEFAULTS.initialSoc_percent),

    maxChargePower_W: num(els.pchg.value, DEFAULTS.maxChargePower_W),
    maxDischargePower_W: num(els.pdis.value, DEFAULTS.maxDischargePower_W),
    maxGridImport_W: num(els.gimp.value, DEFAULTS.maxGridImport_W),
    maxGridExport_W: num(els.gexp.value, DEFAULTS.maxGridExport_W),
    chargeEfficiency_percent: num(els.etaC.value, DEFAULTS.chargeEfficiency_percent),
    dischargeEfficiency_percent: num(els.etaD.value, DEFAULTS.dischargeEfficiency_percent),
    batteryCost_cent_per_kWh: num(els.bwear.value, DEFAULTS.batteryCost_cent_per_kWh),
    terminalSocValuation: els.terminal.value || DEFAULTS.terminalSocValuation,
  };
}

function renderTable(rows, cfg, showKwh = false) {
  const cap = Math.max(1e-9, Number(cfg?.batteryCapacity_Wh ?? 20480));
  const h = Math.max(0.000001, Number(cfg?.stepSize_m ?? 60) / 60); // slot hours
  const W2kWh = (x) => (Number(x) || 0) * h / 1000;

  // Model: key, headerHtml (with <br>), fmt, optional tooltip
  const cols = [
    { key: "t", headerHtml: "t", fmt: (v) => v },
    { key: "load", headerHtml: "Exp.<br>load", fmt: (x) => fmtEnergy(x, { dash: false, forecast: true }), tip: "Expected Load" },
    { key: "pv", headerHtml: "Exp.<br>PV", fmt: (x) => fmtEnergy(x, { dash: false, forecast: true }), tip: "Expected PV" },

    { key: "ic", headerHtml: "Import<br>cost", fmt: dec2Thin },
    { key: "ec", headerHtml: "Export<br>cost", fmt: dec2Thin },

    { key: "g2l", headerHtml: "g2l", fmt: (x) => fmtEnergy(x, { dash: true }), tip: "Grid → Load" },
    { key: "g2b", headerHtml: "g2b", fmt: (x) => fmtEnergy(x, { dash: true }), tip: "Grid → Battery" },
    { key: "pv2l", headerHtml: "pv2l", fmt: (x) => fmtEnergy(x, { dash: true }), tip: "Solar → Load" },
    { key: "pv2b", headerHtml: "pv2b", fmt: (x) => fmtEnergy(x, { dash: true }), tip: "Solar → Battery" },
    { key: "pv2g", headerHtml: "pv2g", fmt: (x) => fmtEnergy(x, { dash: true }), tip: "Solar → Grid" },
    { key: "b2l", headerHtml: "b2l", fmt: (x) => fmtEnergy(x, { dash: true }), tip: "Battery → Load" },
    { key: "b2g", headerHtml: "b2g", fmt: (x) => fmtEnergy(x, { dash: true }), tip: "Battery → Grid" },

    { key: "imp", headerHtml: "Grid<br>import", fmt: (x) => fmtEnergy(x, { dash: true }), tip: "Grid Import" },
    { key: "exp", headerHtml: "Grid<br>export", fmt: (x) => fmtEnergy(x, { dash: true }), tip: "Grid Export" },

    { key: "soc", headerHtml: "SoC", fmt: (w) => pct0(w / cap) + "%" },
  ];

  // Header
  const thead = `
    <thead>
      <tr class="align-bottom">
        ${cols.map(c =>
    `<th class="px-2 py-1 border-b font-medium text-right align-bottom" ${c.tip ? `title="${escapeHtml(c.tip)}"` : ""}>${c.headerHtml}</th>`
  ).join("")}
      </tr>
    </thead>`;

  // Body
  const tbody = `
    <tbody>
      ${rows.map(r => `
        <tr>
          ${cols.map(c => `<td class="px-2 py-1 border-b text-right font-mono tabular-nums">${c.fmt(r[c.key])}</td>`).join("")}
        </tr>`).join("")}
    </tbody>`;

  els.table.innerHTML = thead + tbody;

  // Update the unit badge
  if (els.tableUnit) els.tableUnit.textContent = `Units: ${showKwh ? "kWh" : "W"}`;

  // ---------- formatters ----------
  function fmtEnergy(x, { dash = false, forecast = false } = {}) {
    const raw = Number(x) || 0;
    if (showKwh) {
      const val = W2kWh(raw);
      if (dash && Math.abs(val) < 1e-12) return "–";
      return dec2Thin(val);
    } else {
      const n = Math.round(raw);
      if (dash && n === 0) return "–";
      return intThin(n); // forecasts keep zeros via dash:false above
    }
  }

  function intThin(x) {
    return groupThin(Math.round(Number(x) || 0));
  }
  function dec2Thin(x) {
    const n = Number(x);
    if (!Number.isFinite(n)) return "";
    const s = n.toFixed(2);
    const [i, f] = s.split(".");
    return `${groupThin(i)}.${f}`;
  }
  function pct0(x) {
    const n = (Number(x) || 0) * 100;
    return groupThin(Math.round(n));
  }
  function groupThin(numOrStr) {
    const s = String(numOrStr);
    const neg = s.startsWith("-") ? "-" : "";
    const body = neg ? s.slice(1) : s;
    const parts = body.split(".");
    const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");
    return parts.length > 1 ? `${neg}${intPart}.${parts[1]}` : `${neg}${intPart}`;
  }
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
  }
}



// ---------- small utils ----------
function parseSeries(s) { return (s || "").split(/[\s,]+/).map(Number).filter((x) => Number.isFinite(x)); }
function num(val, fallback) { const n = Number(val); return Number.isFinite(n) ? n : fallback; }
