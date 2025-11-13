// Import shared logic
import {
  drawFlowsBarStackSigned,
  drawSocChart,
  drawPricesStepLines,
  drawLoadPvGrouped,
} from "./scr/charts.js";
import { renderTable } from "./scr/table.js";
import {
  buildTimingHints,
  getActiveTimestampsMs,
  setActiveTimestampsMs,
} from "./scr/timeline.js";
import { debounce } from "./scr/utils.js";
import { refreshVrmSettings, refreshVrmSeries } from "./scr/api/backend.js";
import { DEFAULTS } from "./scr/config.js";
import { loadInitialConfig, saveConfig } from "./scr/config-store.js";
import { requestRemoteSolve } from "./scr/api/solver.js";
// ---------- DOM ----------
const $ = (sel) => document.querySelector(sel);
const els = {
  // actions
  run: $("#run"),
  restore: $("#restore"),

  // numeric inputs
  step: $("#step"), cap: $("#cap"),
  minsoc: $("#minsoc"), maxsoc: $("#maxsoc"), initsoc: $("#initsoc"),
  pchg: $("#pchg"), pdis: $("#pdis"),
  gimp: $("#gimp"), gexp: $("#gexp"),
  etaC: $("#etaC"), etaD: $("#etaD"),
  bwear: $("#bwear"), terminal: $("#terminal"), terminalCustom: $("#terminal-custom"),

  // textareas
  tLoad: $("#ts-load"), tPV: $("#ts-pv"), tIC: $("#ts-ic"), tEC: $("#ts-ec"), tsStart: $("#ts-start"),

  // charts + status
  flows: $("#flows"), soc: $("#soc"), prices: $("#prices"), loadpv: $("#loadpv"),
  table: $("#table"),
  tableKwh: $("#table-kwh"),
  tableUnit: $("#table-unit"),
  status: $("#status"), objective: $("#objective"),

  // VRM section
  vrmFetchSettings: $("#vrm-fetch-settings"),
  vrmFetchForecasts: $("#vrm-fetch-forecasts"),
};

// ---------- State ----------
const debounceRun = debounce(onRun, 250);
const persistConfigDebounced = debounce(
  (cfg) => { void persistConfig(cfg); },
  600,
);

// ---------- Boot ----------
boot();

async function boot() {
  const { config: initialConfig, source: initialSource } = await loadInitialConfig(DEFAULTS);

  hydrateUI(initialConfig);

  wireGlobalInputs();
  wireVrmInputs();

  if (els.status) {
    const note = initialSource === "api"
      ? "Loaded settings from API."
      : "Using defaults (API settings unavailable).";
    els.status.textContent = note;
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

  // Auto-save whenever anything changes
  for (const el of document.querySelectorAll("input, select, textarea")) {
    // tableKwh has its own change handler below, so we exclude it from auto-save/debounce here
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

  // Restore defaults
  els.restore?.addEventListener("click", async () => {
    hydrateUI(DEFAULTS);
    await persistConfig();
    onRun();
  });

}

function wireVrmInputs() {
  els.vrmFetchSettings?.addEventListener("click", onRefreshVrmSettings);
  els.vrmFetchForecasts?.addEventListener("click", onRefreshVrmSeries);
}

// ---------- UI <-> config ----------
function snapshotUI() {
  return {
    stepSize_m: num(els.step?.value, DEFAULTS.stepSize_m),
    batteryCapacity_Wh: num(els.cap?.value, DEFAULTS.batteryCapacity_Wh),
    minSoc_percent: num(els.minsoc?.value, DEFAULTS.minSoc_percent),
    maxSoc_percent: num(els.maxsoc?.value, DEFAULTS.maxSoc_percent),
    initialSoc_percent: num(els.initsoc?.value, DEFAULTS.initialSoc_percent),
    maxChargePower_W: num(els.pchg?.value, DEFAULTS.maxChargePower_W),
    maxDischargePower_W: num(els.pdis?.value, DEFAULTS.maxDischargePower_W),
    maxGridImport_W: num(els.gimp?.value, DEFAULTS.maxGridImport_W),
    maxGridExport_W: num(els.gexp?.value, DEFAULTS.maxGridExport_W),
    chargeEfficiency_percent: num(els.etaC?.value, DEFAULTS.chargeEfficiency_percent),
    dischargeEfficiency_percent: num(els.etaD?.value, DEFAULTS.dischargeEfficiency_percent),
    batteryCost_cent_per_kWh: num(els.bwear?.value, DEFAULTS.batteryCost_cent_per_kWh),
    terminalSocValuation: els.terminal?.value || DEFAULTS.terminalSocValuation,
    terminalSocCustomPrice_cents_per_kWh: num(els.terminalCustom?.value, DEFAULTS.terminalSocCustomPrice_cents_per_kWh),

    load_W_txt: els.tLoad?.value ?? "",
    pv_W_txt: els.tPV?.value ?? "",
    importPrice_txt: els.tIC?.value ?? "",
    exportPrice_txt: els.tEC?.value ?? "",
    tsStart: els.tsStart?.value || "",
    tableShowKwh: !!els.tableKwh?.checked,
  };
}

function hydrateUI(obj) {
  if (els.step) els.step.value = obj.stepSize_m ?? DEFAULTS.stepSize_m;
  if (els.cap) els.cap.value = obj.batteryCapacity_Wh ?? DEFAULTS.batteryCapacity_Wh;
  if (els.minsoc) els.minsoc.value = obj.minSoc_percent ?? DEFAULTS.minSoc_percent;
  if (els.maxsoc) els.maxsoc.value = obj.maxSoc_percent ?? DEFAULTS.maxSoc_percent;
  if (els.initsoc) els.initsoc.value = obj.initialSoc_percent ?? DEFAULTS.initialSoc_percent;

  if (els.pchg) els.pchg.value = obj.maxChargePower_W ?? DEFAULTS.maxChargePower_W;
  if (els.pdis) els.pdis.value = obj.maxDischargePower_W ?? DEFAULTS.maxDischargePower_W;
  if (els.gimp) els.gimp.value = obj.maxGridImport_W ?? DEFAULTS.maxGridImport_W;
  if (els.gexp) els.gexp.value = obj.maxGridExport_W ?? DEFAULTS.maxGridExport_W;

  if (els.etaC) els.etaC.value = obj.chargeEfficiency_percent ?? DEFAULTS.chargeEfficiency_percent;
  if (els.etaD) els.etaD.value = obj.dischargeEfficiency_percent ?? DEFAULTS.dischargeEfficiency_percent;

  if (els.bwear) els.bwear.value = obj.batteryCost_cent_per_kWh ?? DEFAULTS.batteryCost_cent_per_kWh;
  if (els.terminal) els.terminal.value = obj.terminalSocValuation ?? DEFAULTS.terminalSocValuation;
  if (els.terminalCustom) els.terminalCustom.value = obj.terminalSocCustomPrice_cents_per_kWh ?? DEFAULTS.terminalSocCustomPrice_cents_per_kWh;

  if (els.tLoad) els.tLoad.value = obj.load_W_txt ?? DEFAULTS.load_W_txt;
  if (els.tPV) els.tPV.value = obj.pv_W_txt ?? DEFAULTS.pv_W_txt;
  if (els.tIC) els.tIC.value = obj.importPrice_txt ?? DEFAULTS.importPrice_txt;
  if (els.tEC) els.tEC.value = obj.exportPrice_txt ?? DEFAULTS.exportPrice_txt;
  if (els.tsStart) els.tsStart.value = obj.tsStart || "";
  if (els.tableKwh) els.tableKwh.checked = !!(obj.tableShowKwh ?? DEFAULTS.tableShowKwh);

  updateTerminalCustomUI();
}

// ---------- Actions ----------
async function onRefreshVrmSettings() {
  try {
    if (els.status) els.status.textContent = "Refreshing system settings from VRM…";
    const payload = await refreshVrmSettings();
    const saved = payload?.settings || {};
    hydrateUI({ ...DEFAULTS, ...saved });
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
    hydrateUI({ ...DEFAULTS, ...saved });
    if (els.status) els.status.textContent = "Time series saved from VRM.";
    await onRun(); // re-solve with the freshly persisted series
  } catch (err) {
    console.error(err);
    if (els.status) els.status.textContent = `VRM error: ${err.message}`;
  }
}

// ---------- Main compute ----------
async function onRun() {
  try {
    const cfg = uiToConfig();
    await persistConfig();

    const timing = buildTimingHints(cfg, {
      candidate: getActiveTimestampsMs(),
      tsStartValue: els.tsStart?.value || "",
    });

    const result = await requestRemoteSolve({ config: cfg, timing });
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const statusText = result.status || "OK";
    const objectiveValue = Number(result.objectiveValue);

    let timestampsMs = Array.isArray(result.timestampsMs) ? result.timestampsMs.slice() : null;
    if (!Array.isArray(timestampsMs) || timestampsMs.length !== rows.length) {
      timestampsMs = Array.isArray(timing.timestampsMs) && timing.timestampsMs.length === rows.length
        ? timing.timestampsMs.slice()
        : [];
    }
    if (Array.isArray(timestampsMs) && timestampsMs.length === rows.length) {
      setActiveTimestampsMs(timestampsMs);
    } else {
      setActiveTimestampsMs(null);
    }

    if (els.objective) {
      els.objective.textContent = Number.isFinite(objectiveValue)
        ? objectiveValue.toFixed(2)
        : "—";
    }
    if (els.status) els.status.textContent = ` ${statusText}`;

    renderTable({
      rows,
      cfg,
      timestampsMs,
      targets: { table: els.table, tableUnit: els.tableUnit },
      showKwh: !!els.tableKwh?.checked,
    });

    renderAllCharts(rows, cfg, timestampsMs);
  } catch (err) {
    console.error(err);
    if (els.status) els.status.textContent = `Error: ${err.message}`;
  }
}

// ---------- Helpers ----------
function uiToConfig() {
  const load_W = parseSeries(els.tLoad?.value);
  const pv_W = parseSeries(els.tPV?.value);
  const importPrice = parseSeries(els.tIC?.value);
  const exportPrice = parseSeries(els.tEC?.value);

  const T = Math.min(load_W.length, pv_W.length, importPrice.length, exportPrice.length);
  if (T === 0) throw new Error("No data in time series.");
  const clip = (a) => a.slice(0, T);

  return {
    load_W: clip(load_W),
    pv_W: clip(pv_W),
    importPrice: clip(importPrice),
    exportPrice: clip(exportPrice),

    stepSize_m: num(els.step?.value, DEFAULTS.stepSize_m),
    batteryCapacity_Wh: num(els.cap?.value, DEFAULTS.batteryCapacity_Wh),
    minSoc_percent: num(els.minsoc?.value, DEFAULTS.minSoc_percent),
    maxSoc_percent: num(els.maxsoc?.value, DEFAULTS.maxSoc_percent),
    initialSoc_percent: num(els.initsoc?.value, DEFAULTS.initialSoc_percent),

    maxChargePower_W: num(els.pchg?.value, DEFAULTS.maxChargePower_W),
    maxDischargePower_W: num(els.pdis?.value, DEFAULTS.maxDischargePower_W),
    maxGridImport_W: num(els.gimp?.value, DEFAULTS.maxGridImport_W),
    maxGridExport_W: num(els.gexp?.value, DEFAULTS.maxGridExport_W),
    chargeEfficiency_percent: num(els.etaC?.value, DEFAULTS.chargeEfficiency_percent),
    dischargeEfficiency_percent: num(els.etaD?.value, DEFAULTS.dischargeEfficiency_percent),
    batteryCost_cent_per_kWh: num(els.bwear?.value, DEFAULTS.batteryCost_cent_per_kWh),
    terminalSocValuation: els.terminal?.value || DEFAULTS.terminalSocValuation,
    terminalSocCustomPrice_cents_per_kWh: num(els.terminalCustom?.value, DEFAULTS.terminalSocCustomPrice_cents_per_kWh),
  };
}

function updateTerminalCustomUI() {
  const isCustom = (els.terminal?.value === "custom");
  if (els.terminalCustom) els.terminalCustom.disabled = !isCustom;
}

function renderAllCharts(rows, cfg, timestampsMs) {
  drawFlowsBarStackSigned(els.flows, rows, cfg.stepSize_m, timestampsMs);
  drawSocChart(els.soc, rows, cfg.batteryCapacity_Wh, cfg.stepSize_m, timestampsMs);
  drawPricesStepLines(els.prices, rows, cfg.stepSize_m, timestampsMs);
  drawLoadPvGrouped(els.loadpv, rows, cfg.stepSize_m, timestampsMs);
}

async function persistConfig(cfg = snapshotUI()) {
  const payload = (cfg && typeof cfg.load_W_txt === "string") ? cfg : snapshotUI();
  try {
    await saveConfig(payload);
  } catch (error) {
    console.error("Failed to persist settings", error);
    if (els.status) {
      els.status.textContent = `Settings error: ${error.message}`;
    }
  }
}

function queuePersistSnapshot() {
  persistConfigDebounced(snapshotUI());
}

// ---------- small utils ----------
function parseSeries(s) { return (s || "").split(/[\s,]+/).map(Number).filter((x) => Number.isFinite(x)); }
function num(val, fallback) { const n = Number(val); return Number.isFinite(n) ? n : fallback; }
