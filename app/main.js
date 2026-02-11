// Import shared logic
import {
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

// Import new modules
import {
  getElements,
  wireGlobalInputs,
  wireVrmSettingInput,
  setupSystemCardCollapsible,
} from "./scr/ui-binding.js";
import {
  snapshotUI,
  hydrateUI,
  updatePlanMeta,
  updateSummaryUI,
  updateTerminalCustomUI,
} from "./scr/state.js";

// ---------- DOM ----------
// 'els' is now retrieved via getElements() in boot() and passed around or accessed globally if we kept it global.
// For cleaner refactoring, let's keep a module-level reference initialized in boot,
// or just initialize it at the top level since DOM content is likely ready (module scripts defer).
// However, safer to call getElements() when needed or at top level if we trust DOMContentLoaded.
const els = getElements();

// ---------- State ----------
const debounceRun = debounce(onRun, 250);
const persistConfigDebounced = debounce((cfg) => {
  void persistConfig(cfg);
}, 600);

// ---------- Boot ----------
boot();

async function boot() {
  const { config: initialConfig, source } = await loadInitialConfig();

  hydrateUI(els, initialConfig);

  setupSystemCardCollapsible(els);

  // Wire inputs with callbacks
  wireGlobalInputs(els, {
    onInput: () => {
      queuePersistSnapshot();
      debounceRun();
    },
    onRun: onRun,
    updateTerminalCustomUI: () => updateTerminalCustomUI(els),
  });

  wireVrmSettingInput(els, {
    onRefresh: onRefreshVrmSettings,
  });

  if (els.status) {
    els.status.textContent =
      source === "api" ? "Loaded settings from API." : "No settings yet (use the VRM buttons).";
  }

  // Initial compute
  await onRun();
}

// ---------- Actions ----------
async function onRefreshVrmSettings() {
  try {
    if (els.status) els.status.textContent = "Refreshing system settings from VRM…";
    const payload = await refreshVrmSettings();
    const saved = payload?.settings || {};
    hydrateUI(els, saved);
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
    // Reset color to neutral
    els.status.className = "text-sm font-medium text-ink dark:text-slate-100";
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
    updatePlanMeta(els, result.initialSoc_percent, result.tsStart);

    // Update summary if present
    updateSummaryUI(els, result.summary);

    if (els.status) {
      const nonOptimal =
        typeof solverStatus === "string" &&
        solverStatus.toLowerCase() !== "optimal";

      let label;
      let colorClass = "text-emerald-600 dark:text-emerald-400"; // Green for success

      if (nonOptimal) {
        label = `Plan status: ${solverStatus}`;
        colorClass = "text-amber-600 dark:text-amber-400"; // Amber for warning
      } else if (writeToVictron) {
        label = "Plan updated and sent to Victron.";
      } else {
        label = "Plan updated.";
      }
      els.status.textContent = label;
      els.status.className = `text-sm font-medium ${colorClass}`;
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
      dessDiff: result.dessDiff,
    });

    renderAllCharts(rows, cfgForViz);
  } catch (err) {
    console.error(err);
    if (els.status) {
      els.status.textContent = `Error: ${err.message}`;
      els.status.className = "text-sm font-medium text-red-600 dark:text-red-400";
    }
    // In error, clear summary so it doesn't look "fresh"
    updateSummaryUI(els, null);
  }
}

function renderAllCharts(rows, cfg) {
  drawFlowsBarStackSigned(els.flows, rows, cfg.stepSize_m);
  drawSocChart(els.soc, rows, cfg.stepSize_m);
  drawPricesStepLines(els.prices, rows, cfg.stepSize_m);
  drawLoadPvGrouped(els.loadpv, rows, cfg.stepSize_m);
}

async function persistConfig(cfg = snapshotUI(els)) {
  try {
    await saveConfig(cfg);
  } catch (error) {
    console.error("Failed to persist settings", error);
    if (els.status) els.status.textContent = `Settings error: ${error.message}`;
  }
}

function queuePersistSnapshot() {
  persistConfigDebounced(snapshotUI(els));
}
