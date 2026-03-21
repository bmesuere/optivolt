// Import shared logic
import {
  drawFlowsBarStackSigned,
  drawSocChart,
  drawPricesStepLines,
  drawLoadPvGrouped,
} from "./src/charts.js";
import { renderTable } from "./src/table.js";
import { debounce } from "./src/utils.js";
import { refreshVrmSettings } from "./src/api/api.js";
import { loadInitialConfig, saveConfig } from "./src/config-store.js";
import { requestRemoteSolve, fetchHaEntityState } from "./src/api/api.js";
import { initPredictionsTab } from "./src/predictions.js";
import { updateEvPanel } from "./src/ev-tab.js";

// Import new modules
import {
  getElements,
  wireGlobalInputs,
  wireVrmSettingInput,
} from "./src/ui-binding.js";
import {
  snapshotUI,
  hydrateUI,
  updatePlanMeta,
  updateSummaryUI,
  updateTerminalCustomUI,
} from "./src/state.js";

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

function setupTabSwitcher() {
  const ACTIVE_CLS = 'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium bg-white text-ink shadow-sm dark:bg-slate-700 dark:text-slate-100 transition-all focus:outline-none focus:ring-2 focus:ring-sky-400/50';
  const INACTIVE_CLS = 'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 transition-all focus:outline-none focus:ring-2 focus:ring-sky-400/50';

  const tabs = [
    { tab: document.getElementById('tab-optimizer'),   panel: document.getElementById('panel-optimizer') },
    { tab: document.getElementById('tab-predictions'), panel: document.getElementById('panel-predictions') },
    { tab: document.getElementById('tab-ev'),          panel: document.getElementById('panel-ev') },
    { tab: document.getElementById('tab-settings'),    panel: document.getElementById('panel-settings') },
  ].filter(t => t.tab && t.panel);

  function activateTab(activeIndex) {
    tabs.forEach(({ tab, panel }, i) => {
      const isActive = i === activeIndex;
      panel.classList.toggle('hidden', !isActive);
      tab.setAttribute('aria-selected', String(isActive));
      tab.className = isActive ? ACTIVE_CLS : INACTIVE_CLS;
    });
  }

  tabs.forEach(({ tab }, i) => tab.addEventListener('click', () => activateTab(i)));
  activateTab(0);
}

async function boot() {
  const { config: initialConfig, source } = await loadInitialConfig();

  hydrateUI(els, initialConfig);

  setupTabSwitcher();
  await initPredictionsTab();

  // Wire inputs with callbacks
  wireGlobalInputs(els, {
    onInput: () => {
      queuePersistSnapshot();
      debounceRun();
    },
    onSave: queuePersistSnapshot,
    onRun: onRun,
    updateTerminalCustomUI: () => updateTerminalCustomUI(els),
  });

  wireVrmSettingInput(els, {
    onRefresh: onRefreshVrmSettings,
  });

  wireEvSensorInputs(els);
  initDepartureDatetimeMin(els);

  if (els.status) {
    els.status.textContent =
      source === "api" ? "Loaded settings from API." : "No settings yet (use the VRM buttons).";
  }

  // Fire-and-forget: fetch HA sensor states so the EV Status card shows current values.
  // Not awaited — HA may be slow or unconfigured; the initial solve should not wait for it.
  void refreshEvSensorStates(els);

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
        label = "Plan updated and sent to Victron";
      } else {
        label = "Plan updated";
      }
      els.status.textContent = label;
      els.status.className = `text-sm font-medium ${colorClass}`;
    }

    // Only the few chart/table scalars are read from inputs (already hydrated from /settings)
    const cfgForViz = {
      stepSize_m: Number(els.step?.value),
      batteryCapacity_Wh: Number(els.cap?.value),
    };

    const evSettings = {
      departureTime: els.evDepartureTime?.value || null,
      targetSoc_percent: parseFloat(els.evTargetSoc?.value) || null,
    };

    renderTable({
      rows,
      cfg: cfgForViz,
      targets: { table: els.table, tableUnit: els.tableUnit },
      showKwh: !!els.tableKwh?.checked,
      rebalanceWindow: result.rebalanceWindow ?? null,
      evSettings,
    });

    renderAllCharts(rows, cfgForViz, result.rebalanceWindow ?? null, evSettings);

    updateEvPanel(els, rows, result.summary, cfgForViz.stepSize_m);
    updateEvDepartureQuickSet(els, rows, cfgForViz.stepSize_m);
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

function renderAllCharts(rows, cfg, rebalanceWindow = null, evSettings = null) {
  drawFlowsBarStackSigned(els.flows, rows, cfg.stepSize_m, rebalanceWindow, evSettings);
  drawSocChart(els.soc, rows, cfg.stepSize_m, evSettings);
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

const SENSOR_IND_BASE = "mt-1 block text-xs";
const SENSOR_IND_NEUTRAL = `${SENSOR_IND_BASE} text-slate-500 dark:text-slate-400`;
const SENSOR_IND_SUCCESS = `${SENSOR_IND_BASE} text-emerald-600 dark:text-emerald-400`;
const SENSOR_IND_ERROR = `${SENSOR_IND_BASE} text-red-600 dark:text-red-400`;

function toDatetimeLocal(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function initDepartureDatetimeMin(els) {
  const input = els.evDepartureTime;
  if (!input) return;
  // Round down to the last 15-min block
  const blockMs = Math.floor(Date.now() / (15 * 60 * 1000)) * (15 * 60 * 1000);
  input.min = toDatetimeLocal(new Date(blockMs));
}

async function refreshEvSensorStates(els) {
  const sensors = [
    { input: els.evSocSensor, indicator: els.evSocValue },
    { input: els.evPlugSensor, indicator: els.evPlugValue },
  ];
  await Promise.allSettled(sensors.map(async ({ input, indicator }) => {
    const entityId = input?.value?.trim();
    if (!entityId || !indicator) return;
    try {
      const state = await fetchHaEntityState(entityId);
      indicator.textContent = `Current value: ${state.state}`;
      indicator.className = SENSOR_IND_SUCCESS;
      indicator.dataset.haState = state.state;
    } catch {
      // HA not configured or entity unavailable — leave indicator as-is
    }
  }));
  updateEvSocQuickSet(els);
}

function updateEvDepartureQuickSet(els, rows, stepSize_m) {
  const btn = els.evDepartureQuickSet;
  if (!btn) return;
  const lastRow = rows[rows.length - 1];
  if (!lastRow) {
    btn.disabled = true;
    btn.title = "Run a plan first";
    btn.onclick = null;
    return;
  }
  const endMs = lastRow.timestampMs + stepSize_m * 60 * 1000;
  const d = new Date(endMs);
  const dtLocal = toDatetimeLocal(d);
  btn.disabled = false;
  btn.title = `Set to end of current plan (${d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })})`;
  btn.onclick = () => {
    els.evDepartureTime.value = dtLocal;
    els.evDepartureTime.dispatchEvent(new Event('input', { bubbles: true }));
  };
}

function updateEvSocQuickSet(els) {
  const btn = els.evTargetSocQuickSet;
  if (!btn) return;
  const soc = parseFloat(els.evSocValue?.dataset.haState);
  if (!isNaN(soc)) {
    const rounded = Math.round(soc);
    btn.disabled = false;
    btn.title = `Set to current EV SoC (${rounded}%)`;
    btn.onclick = () => {
      els.evTargetSoc.value = rounded;
      els.evTargetSoc.dispatchEvent(new Event('input', { bubbles: true }));
    };
  } else {
    btn.disabled = true;
    btn.title = "Configure EV SoC sensor first";
    btn.onclick = null;
  }
}

function wireEvSensorInputs(els) {
  const sensors = [
    { input: els.evSocSensor, indicator: els.evSocValue },
    { input: els.evPlugSensor, indicator: els.evPlugValue },
  ];

  for (const { input, indicator } of sensors) {
    if (!input || !indicator) continue;

    let seq = 0; // stale-fetch guard: each blur gets a unique id

    input.addEventListener("input", () => {
      indicator.textContent = "";
      indicator.className = SENSOR_IND_NEUTRAL;
      delete indicator.dataset.haState;
      updateEvSocQuickSet(els);
    });

    input.addEventListener("blur", async () => {
      const entityId = input.value.trim();
      if (!entityId) {
        indicator.textContent = "";
        return;
      }

      const id = ++seq;

      // Cancel any pending debounced save/solve and flush immediately so the
      // server has the latest HA credentials before we validate the entity.
      persistConfigDebounced.cancel();
      debounceRun.cancel();
      await persistConfig();

      if (id !== seq) return; // another blur fired while we were saving

      try {
        const state = await fetchHaEntityState(entityId);
        if (id !== seq) return; // stale response
        indicator.textContent = `Current value: ${state.state}`;
        indicator.className = SENSOR_IND_SUCCESS;
        indicator.dataset.haState = state.state;
        updateEvSocQuickSet(els);
      } catch (err) {
        if (id !== seq) return; // stale response
        indicator.textContent = `Error: ${err.message}`;
        indicator.className = SENSOR_IND_ERROR;
        delete indicator.dataset.haState;
        updateEvSocQuickSet(els);
      }
    });
  }
}
