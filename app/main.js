// Import shared logic
import {
  SOLUTION_COLORS,
  drawFlowsBarStackSigned,
  drawSocChart,
  drawPricesStepLines,
  drawLoadPvGrouped,
} from "./scr/charts.js";
import { renderTable } from "./scr/table.js";
import { debounce } from "./scr/utils.js";
import { refreshVrmSettings } from "./scr/api/backend.js";
import { loadInitialConfig, saveConfig } from "./scr/config-store.js";
import { requestRemoteSolve } from "./scr/api/solver.js";

// ---------- DOM ----------
const $ = (sel) => document.querySelector(sel);
const els = {
  // actions
  run: $("#run"),
  updateDataBeforeRun: $("#update-data-before-run"),
  pushToVictron: $("#push-to-victron"),

  // numeric inputs
  step: $("#step"),
  cap: $("#cap"),
  minsoc: $("#minsoc"),
  maxsoc: $("#maxsoc"),
  pchg: $("#pchg"),
  pdis: $("#pdis"),
  gimp: $("#gimp"),
  gexp: $("#gexp"),
  etaC: $("#etaC"),
  etaD: $("#etaD"),
  bwear: $("#bwear"),
  terminal: $("#terminal"),
  terminalCustom: $("#terminal-custom"),

  // plan metadata
  planSocNow: $("#plan-soc-now"),
  planTsStart: $("#plan-ts-start"),

  // charts + status
  flows: $("#flows"),
  soc: $("#soc"),
  prices: $("#prices"),
  loadpv: $("#loadpv"),
  table: $("#table"),
  tableKwh: $("#table-kwh"),
  tableUnit: $("#table-unit"),
  status: $("#status"),

  // summary fields
  sumLoad: $("#sum-load-kwh"),
  sumPv: $("#sum-pv-kwh"),
  sumLoadGrid: $("#sum-load-grid-kwh"),
  sumLoadBatt: $("#sum-load-batt-kwh"),
  sumLoadPv: $("#sum-load-pv-kwh"),
  loadSplitGridBar: $("#load-split-grid-bar"),
  loadSplitBattBar: $("#load-split-batt-bar"),
  loadSplitPvBar: $("#load-split-pv-bar"),
  avgImport: $("#avg-import-cent"),
  tippingPoint: $("#tipping-point-cent"),

  loadSplitGridBar: $("#load-split-grid-bar"),
  loadSplitBattBar: $("#load-split-batt-bar"),
  loadSplitPvBar: $("#load-split-pv-bar"),

  // VRM section
  vrmFetchSettings: $("#vrm-fetch-settings"),
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
  wireVrmSettingInput();

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

  // Auto-save whenever anything changes (except table toggler and run options)
  for (const el of document.querySelectorAll("input, select, textarea")) {
    if (el === els.tableKwh) continue;
    if (el === els.updateDataBeforeRun) continue; // Checkbox doesn't trigger auto-save
    if (el === els.pushToVictron) continue; // Checkbox doesn't trigger auto-save
    el.addEventListener("input", handleChange);
    el.addEventListener("change", handleChange);
  }

  els.terminal?.addEventListener("change", updateTerminalCustomUI);
  updateTerminalCustomUI();

  // Manual recompute
  els.run?.addEventListener("click", onRun);

  // Units toggle recompute
  els.tableKwh?.addEventListener("change", onRun);
}

// Only wires the settings button now
function wireVrmSettingInput() {
  els.vrmFetchSettings?.addEventListener("click", onRefreshVrmSettings);
}

// ---------- UI <-> settings snapshot ----------
function snapshotUI() {
  return {
    // scalars (SYSTEM)
    stepSize_m: num(els.step?.value),
    batteryCapacity_Wh: num(els.cap?.value),
    minSoc_percent: num(els.minsoc?.value),
    maxSoc_percent: num(els.maxsoc?.value),
    maxChargePower_W: num(els.pchg?.value),
    maxDischargePower_W: num(els.pdis?.value),
    maxGridImport_W: num(els.gimp?.value),
    maxGridExport_W: num(els.gexp?.value),
    chargeEfficiency_percent: num(els.etaC?.value),
    dischargeEfficiency_percent: num(els.etaD?.value),
    batteryCost_cent_per_kWh: num(els.bwear?.value),

    // ALGORITHM
    terminalSocValuation: els.terminal?.value || "zero",
    terminalSocCustomPrice_cents_per_kWh: num(els.terminalCustom?.value),

    // UI-only
    tableShowKwh: !!els.tableKwh?.checked,
    // Note: updateDataBeforeRun / pushToVictron are not part of the persisted settings
  };
}

function hydrateUI(obj = {}) {
  // SYSTEM
  setIfDef(els.step, obj.stepSize_m);
  setIfDef(els.cap, obj.batteryCapacity_Wh);
  setIfDef(els.minsoc, obj.minSoc_percent);
  setIfDef(els.maxsoc, obj.maxSoc_percent);
  setIfDef(els.pchg, obj.maxChargePower_W);
  setIfDef(els.pdis, obj.maxDischargePower_W);
  setIfDef(els.gimp, obj.maxGridImport_W);
  setIfDef(els.gexp, obj.maxGridExport_W);
  setIfDef(els.etaC, obj.chargeEfficiency_percent);
  setIfDef(els.etaD, obj.dischargeEfficiency_percent);
  setIfDef(els.bwear, obj.batteryCost_cent_per_kWh);

  // DATA (display-only metadata)
  updatePlanMeta(obj.initialSoc_percent, obj.tsStart);

  // ALGORITHM
  if (els.terminal && obj.terminalSocValuation != null) {
    els.terminal.value = String(obj.terminalSocValuation);
  }
  setIfDef(els.terminalCustom, obj.terminalSocCustomPrice_cents_per_kWh);

  // UI-only
  if (els.tableKwh && obj.tableShowKwh != null) {
    els.tableKwh.checked = !!obj.tableShowKwh;
  }

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

// ---------- Main compute ----------
async function onRun() {
  // Cancel any pending auto-save to avoid double writes
  if (typeof persistConfigDebounced.cancel === "function") {
    persistConfigDebounced.cancel();
  }

  if (els.status) {
    els.status.textContent = "Calculating…";
  }
  try {
    // Persist current inputs to /settings; server will read these
    await persistConfig();

    // Run options
    const updateData = !!els.updateDataBeforeRun?.checked;
    const writeToVictron = !!els.pushToVictron?.checked;

    // Solve with server-only settings/timing, passing the flags
    const result = await requestRemoteSolve({ updateData, writeToVictron });

    const rows = Array.isArray(result?.rows) ? result.rows : [];
    const solverStatus =
      typeof result?.solverStatus === "string" ? result.solverStatus : "OK";

    // Update SoC and tsStart from result
    updatePlanMeta(result.initialSoc_percent, result.tsStart);

    // Update summary if present
    updateSummaryUI(result.summary);

    if (els.status) {
      const nonOptimal =
        typeof solverStatus === "string" &&
        solverStatus.toLowerCase() !== "optimal";

      let label;
      if (nonOptimal) {
        label = `Plan status: ${solverStatus}`;
      } else if (writeToVictron) {
        label = "Plan updated and sent to Victron.";
      } else {
        label = "Plan updated.";
      }
      els.status.textContent = label;
    }

    // Only the few chart/table scalars are read from inputs (already hydrated from /settings)
    const cfgForViz = {
      stepSize_m: Number(els.step?.value),
      batteryCapacity_Wh: Number(els.cap?.value),
    };

    renderTable({
      rows,
      cfg: cfgForViz,
      targets: { table: els.table, tableUnit: els.tableUnit },
      showKwh: !!els.tableKwh?.checked,
    });

    renderAllCharts(rows, cfgForViz);
  } catch (err) {
    console.error(err);
    if (els.status) els.status.textContent = `Error: ${err.message}`;
    // In error, clear summary so it doesn't look "fresh"
    updateSummaryUI(null);
  }
}


// ---------- Helpers ----------
function updateTerminalCustomUI() {
  const isCustom = els.terminal?.value === "custom";
  if (els.terminalCustom) els.terminalCustom.disabled = !isCustom;
}

function renderAllCharts(rows, cfg) {
  drawFlowsBarStackSigned(els.flows, rows, cfg.stepSize_m);
  drawSocChart(els.soc, rows, cfg.stepSize_m);
  drawPricesStepLines(els.prices, rows, cfg.stepSize_m);
  drawLoadPvGrouped(els.loadpv, rows, cfg.stepSize_m);
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

// Plan metadata helper
function updatePlanMeta(initialSoc_percent, tsStart) {
  if (els.planSocNow) {
    if (initialSoc_percent == null || !Number.isFinite(Number(initialSoc_percent))) {
      els.planSocNow.textContent = "—";
    } else {
      const n = Number(initialSoc_percent);
      els.planSocNow.textContent = String(Math.round(n));
    }
  }

  if (els.planTsStart) {
    if (!tsStart) {
      els.planTsStart.textContent = "—";
    } else {
      const raw = String(tsStart);
      let display = raw;
      if (raw.includes("T")) {
        const [datePart, timePart] = raw.split("T");
        const [y, m, d] = datePart.split("-");
        if (y && m && d && timePart) {
          display = `${d}/${m} ${timePart}`;
        }
      }
      els.planTsStart.textContent = display;
    }
  }
}

// Summary helper
function updateSummaryUI(summary) {
  if (!summary) {
    setText(els.sumLoad, "—");
    setText(els.sumPv, "—");
    setText(els.sumLoadGrid, "—");
    setText(els.sumLoadBatt, "—");
    setText(els.sumLoadPv, "—");
    setText(els.avgImport, "—");
    setText(els.tippingPoint, "—");

    // reset mini bar
    if (els.loadSplitGridBar && els.loadSplitBattBar && els.loadSplitPvBar) {
      [els.loadSplitGridBar, els.loadSplitBattBar, els.loadSplitPvBar].forEach(el => {
        el.style.width = "0%";
        el.style.opacity = "0";
      });
    }
    return;
  }

  const {
    loadTotal_kWh,
    pvTotal_kWh,
    loadFromGrid_kWh,
    loadFromBattery_kWh,
    loadFromPv_kWh,
    avgImportPrice_cents_per_kWh,
    firstSegmentTippingPoint_cents_per_kWh,
  } = summary;

  setText(els.sumLoad, formatKWh(loadTotal_kWh));
  setText(els.sumPv, formatKWh(pvTotal_kWh));
  setText(els.sumLoadGrid, formatKWh(loadFromGrid_kWh));
  setText(els.sumLoadBatt, formatKWh(loadFromBattery_kWh));
  setText(els.sumLoadPv, formatKWh(loadFromPv_kWh));
  setText(els.avgImport, formatCentsPerKWh(avgImportPrice_cents_per_kWh));
  setText(els.tippingPoint, formatCentsPerKWh(firstSegmentTippingPoint_cents_per_kWh));

  const total =
    (Number(loadFromGrid_kWh) || 0) +
    (Number(loadFromBattery_kWh) || 0) +
    (Number(loadFromPv_kWh) || 0);

  const gridEl = els.loadSplitGridBar;
  const battEl = els.loadSplitBattBar;
  const pvEl = els.loadSplitPvBar;

  if (!gridEl || !battEl || !pvEl) return;

  if (total <= 0) {
    // nothing to show
    [gridEl, battEl, pvEl].forEach(el => {
      el.style.width = "0%";
      el.style.opacity = "0";
    });
    return;
  }

  const gridPct = (Number(loadFromGrid_kWh) || 0) / total * 100;
  const battPct = (Number(loadFromBattery_kWh) || 0) / total * 100;
  const pvPct = (Number(loadFromPv_kWh) || 0) / total * 100;

  gridEl.style.width = `${gridPct}%`;
  battEl.style.width = `${battPct}%`;
  pvEl.style.width = `${pvPct}%`;

  // match flows chart colors: g2l, b2l, pv2l
  gridEl.style.backgroundColor = SOLUTION_COLORS.g2l;
  battEl.style.backgroundColor = SOLUTION_COLORS.b2l;
  pvEl.style.backgroundColor = SOLUTION_COLORS.pv2l;

  [gridEl, battEl, pvEl].forEach(el => {
    el.style.opacity = "1";
  });
}


function updateLoadSplitBars(gridKWh, battKWh, pvKWh) {
  const g = Number(gridKWh);
  const b = Number(battKWh);
  const p = Number(pvKWh);

  const values = [
    Number.isFinite(g) && g > 0 ? g : 0,
    Number.isFinite(b) && b > 0 ? b : 0,
    Number.isFinite(p) && p > 0 ? p : 0,
  ];
  const total = values[0] + values[1] + values[2];

  const bars = [
    els.loadSplitGridBar,
    els.loadSplitBattBar,
    els.loadSplitPvBar,
  ];

  if (!total || !Number.isFinite(total)) {
    for (const bar of bars) {
      if (!bar) continue;
      bar.style.width = "0%";
      bar.style.opacity = "0";
    }
    return;
  }

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!bar) continue;
    const v = values[i];
    const pct = v <= 0 ? 0 : (v / total) * 100;
    bar.style.width = `${pct.toFixed(1)}%`;
    bar.style.opacity = pct > 0 ? "1" : "0";
  }
}

// small utils
function setIfDef(el, v) {
  if (!el) return;
  if (v === 0) {
    if ("value" in el) el.value = "0";
    else el.textContent = "0";
    return;
  }
  if (v == null || (typeof v === "string" && v.length === 0)) return;
  const s = String(v);
  if ("value" in el) el.value = s;
  else el.textContent = s;
}

function num(val) {
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function setText(el, txt) {
  if (!el) return;
  el.textContent = txt;
}

function formatKWh(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) < 0.005) return "0.00 kWh";
  return `${n.toFixed(2)} kWh`;
}

function formatCentsPerKWh(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(2)} c€/kWh`;
}
