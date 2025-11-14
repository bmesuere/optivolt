// Import shared logic
import {
  drawFlowsBarStackSigned,
  drawSocChart,
  drawPricesStepLines,
  drawLoadPvGrouped,
} from "./scr/charts.js";
import { renderTable } from "./scr/table.js";
import { debounce } from "./scr/utils.js";
import { refreshVrmSettings, refreshVrmSeries } from "./scr/api/backend.js";
import { loadInitialConfig, saveConfig } from "./scr/config-store.js";
import { requestRemoteSolve } from "./scr/api/solver.js";

// ---------- DOM ----------
const $ = (sel) => document.querySelector(sel);
const els = {
  // actions
  run: $("#run"),

  // numeric inputs
  step: $("#step"),
  cap: $("#cap"),
  minsoc: $("#minsoc"),
  maxsoc: $("#maxsoc"),
  initsoc: $("#initsoc"),
  pchg: $("#pchg"),
  pdis: $("#pdis"),
  gimp: $("#gimp"),
  gexp: $("#gexp"),
  etaC: $("#etaC"),
  etaD: $("#etaD"),
  bwear: $("#bwear"),
  terminal: $("#terminal"),
  terminalCustom: $("#terminal-custom"),

  // textareas
  tLoad: $("#ts-load"),
  tPV: $("#ts-pv"),
  tIC: $("#ts-ic"),
  tEC: $("#ts-ec"),
  tsStart: $("#ts-start"),

  // charts + status
  flows: $("#flows"),
  soc: $("#soc"),
  prices: $("#prices"),
  loadpv: $("#loadpv"),
  table: $("#table"),
  tableKwh: $("#table-kwh"),
  tableUnit: $("#table-unit"),
  status: $("#status"),
  objective: $("#objective"),

  // VRM section
  vrmFetchSettings: $("#vrm-fetch-settings"),
  vrmFetchForecasts: $("#vrm-fetch-forecasts"),
};

// ---------- State ----------
const debounceRun = debounce(onRun, 250);
const persistConfigDebounced = debounce((cfg) => {
  void persistConfig(cfg);
}, 600);

// ---------- Boot ----------
boot();

async function boot() {
  const { config: initialConfig, source } = await loadInitialConfig();

  hydrateUI(initialConfig);

  wireGlobalInputs();
  wireVrmInputs();

  if (els.status) {
    els.status.textContent =
      source === "api" ? "Loaded settings from API." : "No settings yet (use the VRM buttons).";
  }

  // Initial compute
  await onRun();
}

// ---------- Wiring ----------
function wireGlobalInputs() {
  const handleChange = () => {
    queuePersistSnapshot();
    debounceRun();
  };

  // Auto-save whenever anything changes (except the table toggler)
  for (const el of document.querySelectorAll("input, select, textarea")) {
    if (el === els.tableKwh) continue;
    el.addEventListener("input", handleChange);
    el.addEventListener("change", handleChange);
  }

  els.terminal?.addEventListener("change", updateTerminalCustomUI);
  updateTerminalCustomUI();

  // Manual recompute
  els.run?.addEventListener("click", onRun);

  // Units toggle recompute
  els.tableKwh?.addEventListener("change", async () => {
    await persistConfig();
    onRun();
  });
}

function wireVrmInputs() {
  els.vrmFetchSettings?.addEventListener("click", onRefreshVrmSettings);
  els.vrmFetchForecasts?.addEventListener("click", onRefreshVrmSeries);
}

// ---------- UI <-> settings snapshot ----------
function snapshotUI() {
  return {
    // scalars
    stepSize_m: num(els.step?.value),
    batteryCapacity_Wh: num(els.cap?.value),
    minSoc_percent: num(els.minsoc?.value),
    maxSoc_percent: num(els.maxsoc?.value),
    initialSoc_percent: num(els.initsoc?.value),
    maxChargePower_W: num(els.pchg?.value),
    maxDischargePower_W: num(els.pdis?.value),
    maxGridImport_W: num(els.gimp?.value),
    maxGridExport_W: num(els.gexp?.value),
    chargeEfficiency_percent: num(els.etaC?.value),
    dischargeEfficiency_percent: num(els.etaD?.value),
    batteryCost_cent_per_kWh: num(els.bwear?.value),
    terminalSocValuation: els.terminal?.value || "zero",
    terminalSocCustomPrice_cents_per_kWh: num(els.terminalCustom?.value),

    // series as TEXT (server parses *_txt or concrete arrays)
    load_W_txt: els.tLoad?.value ?? "",
    pv_W_txt: els.tPV?.value ?? "",
    importPrice_txt: els.tIC?.value ?? "",
    exportPrice_txt: els.tEC?.value ?? "",

    // optional timeline hint
    tsStart: els.tsStart?.value || "",

    // UI-only
    tableShowKwh: !!els.tableKwh?.checked,
  };
}

function hydrateUI(obj = {}) {
  // only set when present; otherwise keep current input values/HTML defaults
  setIfDef(els.step, obj.stepSize_m);
  setIfDef(els.cap, obj.batteryCapacity_Wh);
  setIfDef(els.minsoc, obj.minSoc_percent);
  setIfDef(els.maxsoc, obj.maxSoc_percent);
  setIfDef(els.initsoc, obj.initialSoc_percent);
  setIfDef(els.pchg, obj.maxChargePower_W);
  setIfDef(els.pdis, obj.maxDischargePower_W);
  setIfDef(els.gimp, obj.maxGridImport_W);
  setIfDef(els.gexp, obj.maxGridExport_W);
  setIfDef(els.etaC, obj.chargeEfficiency_percent);
  setIfDef(els.etaD, obj.dischargeEfficiency_percent);
  setIfDef(els.bwear, obj.batteryCost_cent_per_kWh);
  if (els.terminal && obj.terminalSocValuation != null) els.terminal.value = String(obj.terminalSocValuation);
  setIfDef(els.terminalCustom, obj.terminalSocCustomPrice_cents_per_kWh);

  if (els.tLoad && obj.load_W_txt != null) els.tLoad.value = String(obj.load_W_txt);
  if (els.tPV && obj.pv_W_txt != null) els.tPV.value = String(obj.pv_W_txt);
  if (els.tIC && obj.importPrice_txt != null) els.tIC.value = String(obj.importPrice_txt);
  if (els.tEC && obj.exportPrice_txt != null) els.tEC.value = String(obj.exportPrice_txt);
  if (els.tsStart && obj.tsStart != null) els.tsStart.value = String(obj.tsStart);

  if (els.tableKwh && obj.tableShowKwh != null) els.tableKwh.checked = !!obj.tableShowKwh;

  updateTerminalCustomUI();
}

// ---------- Actions ----------
async function onRefreshVrmSettings() {
  try {
    if (els.status) els.status.textContent = "Refreshing system settings from VRM…";
    const payload = await refreshVrmSettings();
    const saved = payload?.settings || {};
    hydrateUI(saved);
    if (els.status) els.status.textContent = "System settings saved from VRM.";
  } catch (err) {
    console.error(err);
    if (els.status) els.status.textContent = `VRM error: ${err.message}`;
  }
}

async function onRefreshVrmSeries() {
  try {
    if (els.status) els.status.textContent = "Refreshing time series from VRM…";
    const payload = await refreshVrmSeries();
    const saved = payload?.settings || {};
    hydrateUI(saved);
    if (els.status) els.status.textContent = "Time series saved from VRM.";
    await onRun(); // re-solve with freshly persisted series
  } catch (err) {
    console.error(err);
    if (els.status) els.status.textContent = `VRM error: ${err.message}`;
  }
}

// ---------- Main compute ----------
async function onRun() {
  try {
    // Persist current inputs to /settings; server will read these
    await persistConfig();

    // Solve with server-only settings/timing
    const result = await requestRemoteSolve();
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    const timestampsMs = Array.isArray(result?.timestampsMs) ? result.timestampsMs : [];
    const objectiveValue = Number(result?.objectiveValue);
    const statusText = result?.status || "OK";

    if (els.objective) {
      els.objective.textContent = Number.isFinite(objectiveValue) ? objectiveValue.toFixed(2) : "—";
    }
    if (els.status) els.status.textContent = ` ${statusText}`;

    // Only the few chart/table scalars are read from inputs (already hydrated from /settings)
    const cfgForViz = {
      stepSize_m: Number(els.step?.value) || 15,
      batteryCapacity_Wh: Number(els.cap?.value) || 20480,
    };

    renderTable({
      rows,
      cfg: cfgForViz,
      timestampsMs,
      targets: { table: els.table, tableUnit: els.tableUnit },
      showKwh: !!els.tableKwh?.checked,
    });

    renderAllCharts(rows, cfgForViz, timestampsMs);
  } catch (err) {
    console.error(err);
    if (els.status) els.status.textContent = `Error: ${err.message}`;
  }
}


// ---------- Helpers ----------
function updateTerminalCustomUI() {
  const isCustom = els.terminal?.value === "custom";
  if (els.terminalCustom) els.terminalCustom.disabled = !isCustom;
}

function renderAllCharts(rows, cfg, timestampsMs) {
  drawFlowsBarStackSigned(els.flows, rows, cfg.stepSize_m, timestampsMs);
  drawSocChart(els.soc, rows, cfg.batteryCapacity_Wh, cfg.stepSize_m, timestampsMs);
  drawPricesStepLines(els.prices, rows, cfg.stepSize_m, timestampsMs);
  drawLoadPvGrouped(els.loadpv, rows, cfg.stepSize_m, timestampsMs);
}

async function persistConfig(cfg = snapshotUI()) {
  try {
    await saveConfig(cfg);
  } catch (error) {
    console.error("Failed to persist settings", error);
    if (els.status) els.status.textContent = `Settings error: ${error.message}`;
  }
}

function queuePersistSnapshot() {
  persistConfigDebounced(snapshotUI());
}

// small utils
function setIfDef(el, v) {
  if (!el) return;
  if (v == null || (typeof v === "string" && v.length === 0)) return;
  el.value = String(v);
}
function num(val) {
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}
