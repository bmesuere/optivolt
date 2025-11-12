// Import shared logic
import {
  drawFlowsBarStackSigned,
  drawSocChart,
  drawPricesStepLines,
  drawLoadPvGrouped,
} from "./scr/charts.js";
import { renderTable } from "./scr/table.js";
import {
  lastQuarterMs,
  toLocalDatetimeLocal,
  buildTimingHints,
  getActiveTimestampsMs,
  setActiveTimestampsMs,
} from "./scr/timeline.js";
import { debounce } from "./scr/utils.js";
import { fetchVrmSettings, fetchVrmTimeseries } from "./scr/api/backend.js";
import { flattenStructured, loadInitialConfig, saveConfig } from "./scr/config-store.js";
import { requestRemoteSolve } from "./scr/api/solver.js";
// ---------- DOM ----------
const $ = (sel) => document.querySelector(sel);
const root = document.documentElement;
const THEME_STORAGE_KEY = "battery-ui-theme";
const els = {
  // actions
  run: $("#run"),
  restore: $("#restore"),
  themeToggle: $("#themeToggle"),

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

let darkModeEnabled = root.classList.contains("dark");
let lastKnownConfig = {};

// ---------- Boot ----------
boot();

async function boot() {
  const { config: initialConfig, source: initialSource } = await loadInitialConfig();

  hydrateUI(initialConfig);

  wireGlobalInputs();
  wireThemeToggle();
  wireVrmInputs();

  if (els.status) {
    const note = initialSource === "api"
      ? "Loaded settings from API."
      : "Failed to load settings from API.";
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

}

function wireThemeToggle() {
  if (!els.themeToggle) return;
  els.themeToggle.addEventListener("click", async () => {
    toggleDarkMode();
    await persistConfig();
  });
}

function wireVrmInputs() {
  els.vrmFetchSettings?.addEventListener("click", onFetchVRMSettings);
  els.vrmFetchForecasts?.addEventListener("click", onFetchVRMForecasts);
}

// ---------- UI <-> config ----------
function snapshotUI() {
  return {
    stepSize_m: num(els.step?.value, fallbackNumber("stepSize_m")),
    batteryCapacity_Wh: num(els.cap?.value, fallbackNumber("batteryCapacity_Wh")),
    minSoc_percent: num(els.minsoc?.value, fallbackNumber("minSoc_percent")),
    maxSoc_percent: num(els.maxsoc?.value, fallbackNumber("maxSoc_percent")),
    initialSoc_percent: num(els.initsoc?.value, fallbackNumber("initialSoc_percent")),

    maxChargePower_W: num(els.pchg?.value, fallbackNumber("maxChargePower_W")),
    maxDischargePower_W: num(els.pdis?.value, fallbackNumber("maxDischargePower_W")),
    maxGridImport_W: num(els.gimp?.value, fallbackNumber("maxGridImport_W")),
    maxGridExport_W: num(els.gexp?.value, fallbackNumber("maxGridExport_W")),
    chargeEfficiency_percent: num(els.etaC?.value, fallbackNumber("chargeEfficiency_percent")),
    dischargeEfficiency_percent: num(els.etaD?.value, fallbackNumber("dischargeEfficiency_percent")),
    batteryCost_cent_per_kWh: num(els.bwear?.value, fallbackNumber("batteryCost_cent_per_kWh")),
    terminalSocValuation: els.terminal?.value || fallbackEnum("terminalSocValuation", "zero"),
    terminalSocCustomPrice_cents_per_kWh: num(els.terminalCustom?.value, fallbackNumber("terminalSocCustomPrice_cents_per_kWh")),

    load_W_txt: typeof els.tLoad?.value === "string" ? els.tLoad.value : fallbackString("load_W_txt"),
    pv_W_txt: typeof els.tPV?.value === "string" ? els.tPV.value : fallbackString("pv_W_txt"),
    importPrice_txt: typeof els.tIC?.value === "string" ? els.tIC.value : fallbackString("importPrice_txt"),
    exportPrice_txt: typeof els.tEC?.value === "string" ? els.tEC.value : fallbackString("exportPrice_txt"),
    tsStart: typeof els.tsStart?.value === "string" ? els.tsStart.value : fallbackString("tsStart"),
    tableShowKwh: els.tableKwh ? !!els.tableKwh.checked : fallbackBoolean("tableShowKwh"),
    darkMode: darkModeEnabled ?? fallbackBoolean("darkMode"),
  };
}

function hydrateUI(snapshot = {}) {
  if (!snapshot || typeof snapshot !== "object") return;

  lastKnownConfig = { ...lastKnownConfig, ...snapshot };
  const cfg = lastKnownConfig;

  if (els.step) els.step.value = cfg.stepSize_m ?? "";
  if (els.cap) els.cap.value = cfg.batteryCapacity_Wh ?? "";
  if (els.minsoc) els.minsoc.value = cfg.minSoc_percent ?? "";
  if (els.maxsoc) els.maxsoc.value = cfg.maxSoc_percent ?? "";
  if (els.initsoc) els.initsoc.value = cfg.initialSoc_percent ?? "";

  if (els.pchg) els.pchg.value = cfg.maxChargePower_W ?? "";
  if (els.pdis) els.pdis.value = cfg.maxDischargePower_W ?? "";
  if (els.gimp) els.gimp.value = cfg.maxGridImport_W ?? "";
  if (els.gexp) els.gexp.value = cfg.maxGridExport_W ?? "";

  if (els.etaC) els.etaC.value = cfg.chargeEfficiency_percent ?? "";
  if (els.etaD) els.etaD.value = cfg.dischargeEfficiency_percent ?? "";

  if (els.bwear) els.bwear.value = cfg.batteryCost_cent_per_kWh ?? "";
  if (els.terminal) els.terminal.value = cfg.terminalSocValuation ?? "zero";
  if (els.terminalCustom) {
    const custom = cfg.terminalSocCustomPrice_cents_per_kWh;
    els.terminalCustom.value = custom ?? "";
  }

  if (els.tLoad) els.tLoad.value = typeof cfg.load_W_txt === "string" ? cfg.load_W_txt : "";
  if (els.tPV) els.tPV.value = typeof cfg.pv_W_txt === "string" ? cfg.pv_W_txt : "";
  if (els.tIC) els.tIC.value = typeof cfg.importPrice_txt === "string" ? cfg.importPrice_txt : "";
  if (els.tEC) els.tEC.value = typeof cfg.exportPrice_txt === "string" ? cfg.exportPrice_txt : "";
  if (els.tsStart) els.tsStart.value = cfg.tsStart ?? "";
  if (els.tableKwh) els.tableKwh.checked = !!cfg.tableShowKwh;

  setDarkMode(!!cfg.darkMode);

  updateTerminalCustomUI();
}

// ---------- Actions ----------
async function onFetchVRMSettings() {
  try {
    if (els.status) els.status.textContent = "Syncing system settings from VRM…";
    const structured = await fetchVrmSettings();
    if (!structured || typeof structured !== "object") {
      throw new Error("Invalid VRM settings response");
    }

    const merged = flattenStructured(structured);
    hydrateUI(merged);

    if (els.status) els.status.textContent = "System settings synced from VRM.";
    await onRun();
  } catch (err) {
    console.error(err);
    if (els.status) els.status.textContent = `VRM sync error: ${err.message}`;
  }
}

async function onFetchVRMForecasts() {
  try {
    if (els.status) els.status.textContent = "Fetching VRM forecasts, prices & SoC…";
    const timeseries = await fetchVrmTimeseries();
    const fc = timeseries?.forecasts ?? {};
    const pr = timeseries?.prices ?? {};
    const soc = timeseries?.soc;

    // Decide the optimizer start time: last quarter (local)
    const quarterStartMs = lastQuarterMs(new Date());
    if (els.tsStart) {
      els.tsStart.value = toLocalDatetimeLocal(new Date(quarterStartMs));
    }

    // Determine step and compute offset (how many slots to drop from full-hour → quarter)
    const stepMin = num(els.step?.value, fc.step_minutes || 15); // keep user's step if set; else VRM or 15
    const fullHourStartMs = Array.isArray(fc.timestamps) && fc.timestamps.length > 0
      ? Number(fc.timestamps[0])
      : (() => { const d = new Date(); d.setMinutes(0, 0, 0); return d.getTime(); })();

    let offsetSlots = Math.floor((quarterStartMs - fullHourStartMs) / (stepMin * 60 * 1000));
    if (!Number.isFinite(offsetSlots) || offsetSlots < 0) offsetSlots = 0;
    // Clamp to at most 3 if step=15 and we only shifted within the same hour
    if (stepMin === 15) offsetSlots = Math.min(offsetSlots, 3);

    // Slice helpers
    const slice = (arr) => (Array.isArray(arr) ? arr.slice(offsetSlots) : []);

    // Fill the per-slot series from VRM, but starting at the last quarter
    if (els.tLoad) els.tLoad.value = slice(fc.load_W).join(",");
    if (els.tPV) els.tPV.value = slice(fc.pv_W).join(",");
    if (els.tIC) els.tIC.value = slice(pr.importPrice_cents_per_kwh).join(",");
    if (els.tEC) els.tEC.value = slice(pr.exportPrice_cents_per_kwh).join(",");

    if (soc && Number.isFinite(soc.soc_percent)) {
      const clamped = Math.max(0, Math.min(100, Number(soc.soc_percent)));
      if (els.initsoc) els.initsoc.value = String(clamped);
    }

    await persistConfig();

    if (els.status) {
      els.status.textContent = soc && Number.isFinite(soc.soc_percent)
        ? `Forecasts, prices & SoC loaded from VRM (SoC ${soc.soc_percent}%).`
        : "Forecasts & prices loaded from VRM (SoC unavailable).";
    }

    await onRun();
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

    const result = await requestRemoteSolve({ timing });
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

    stepSize_m: num(els.step?.value, fallbackNumber("stepSize_m")),
    batteryCapacity_Wh: num(els.cap?.value, fallbackNumber("batteryCapacity_Wh")),
    minSoc_percent: num(els.minsoc?.value, fallbackNumber("minSoc_percent")),
    maxSoc_percent: num(els.maxsoc?.value, fallbackNumber("maxSoc_percent")),
    initialSoc_percent: num(els.initsoc?.value, fallbackNumber("initialSoc_percent")),

    maxChargePower_W: num(els.pchg?.value, fallbackNumber("maxChargePower_W")),
    maxDischargePower_W: num(els.pdis?.value, fallbackNumber("maxDischargePower_W")),
    maxGridImport_W: num(els.gimp?.value, fallbackNumber("maxGridImport_W")),
    maxGridExport_W: num(els.gexp?.value, fallbackNumber("maxGridExport_W")),
    chargeEfficiency_percent: num(els.etaC?.value, fallbackNumber("chargeEfficiency_percent")),
    dischargeEfficiency_percent: num(els.etaD?.value, fallbackNumber("dischargeEfficiency_percent")),
    batteryCost_cent_per_kWh: num(els.bwear?.value, fallbackNumber("batteryCost_cent_per_kWh")),
    terminalSocValuation: els.terminal?.value || fallbackEnum("terminalSocValuation", "zero"),
    terminalSocCustomPrice_cents_per_kWh: num(els.terminalCustom?.value, fallbackNumber("terminalSocCustomPrice_cents_per_kWh")),
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

function toggleDarkMode() {
  setDarkMode(!darkModeEnabled);
}

function setDarkMode(enabled, { persistLocal = true } = {}) {
  darkModeEnabled = !!enabled;
  root.classList.toggle("dark", darkModeEnabled);
  if (!persistLocal) return;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, darkModeEnabled ? "dark" : "light");
  } catch {
    // Ignore storage errors (e.g. Safari private mode)
  }
}

async function persistConfig(cfg = snapshotUI()) {
  const payload = (cfg && typeof cfg.load_W_txt === "string") ? cfg : snapshotUI();
  try {
    await saveConfig(payload);
    lastKnownConfig = { ...lastKnownConfig, ...payload };
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
function fallbackNumber(key) { const value = Number(lastKnownConfig[key]); return Number.isFinite(value) ? value : undefined; }
function fallbackString(key) { const value = lastKnownConfig[key]; return typeof value === "string" ? value : ""; }
function fallbackBoolean(key) { const value = lastKnownConfig[key]; return typeof value === "boolean" ? value : false; }
function fallbackEnum(key, defaultValue = "") { const value = lastKnownConfig[key]; return typeof value === "string" ? value : defaultValue; }
