import {
  drawFlowsBarStackSigned,
  drawSocChart,
  drawPricesStepLines,
  drawLoadPvGrouped,
} from "./charts.js";
import { renderTable } from "./table.js";
import { debounce } from "./utils.js";
import { saveConfig } from "./config-store.js";
import { requestRemoteSolve } from "./api/api.js";
import { updateEvPanel, collectEvSettings } from "./ev-tab.js";
import {
  snapshotUI,
  updatePlanMeta,
  updateRebalanceNudgeUI,
  updateSummaryUI,
} from "./state.js";
import {
  aggregateRowsHourly,
  clampRebalanceWindow,
  getStoredFlowsResolution,
  getStoredViewRange,
  mapRebalanceWindowToRows,
  planExceedsStandardView,
  rowsSpanHours,
  sliceRowsToStandardView,
  storeFlowsResolution,
  storeViewRange,
} from "./plan-view.js";

export function createOptimizerController({ els, services = {}, getEvEntries = () => [], onPlanRows = () => {} }) {
  const deps = {
    debounce,
    drawFlowsBarStackSigned,
    drawLoadPvGrouped,
    drawPricesStepLines,
    drawSocChart,
    renderTable,
    requestRemoteSolve,
    saveConfig,
    snapshotUI,
    updateEvPanel,
    updatePlanMeta,
    updateRebalanceNudgeUI,
    updateSummaryUI,
    ...services,
  };

  let lastTableRows = [];
  let lastTableRebalanceWindow = null;
  let lastPricesKnownUntilMs = null;

  const debounceRun = deps.debounce(onRun, 250);
  const persistConfigDebounced = deps.debounce((cfg) => {
    void persistConfig(cfg);
  }, 600);

  async function onRun() {
    if (typeof persistConfigDebounced.cancel === "function") {
      persistConfigDebounced.cancel();
    }

    if (els.status) {
      els.status.textContent = "Calculating…";
      els.status.className = "text-sm font-medium text-ink dark:text-slate-100";
    }

    const runBtn = els.run;
    if (runBtn) {
      runBtn.classList.add('loading');
      runBtn.disabled = true;
    }

    try {
      await persistConfig();

      const updateData = !!els.updateDataBeforeRun?.checked;
      const writeToVictron = !!els.pushToVictron?.checked;
      const result = await deps.requestRemoteSolve({ updateData, writeToVictron });

      const rows = Array.isArray(result?.rows) ? result.rows : [];
      const solverStatus =
        typeof result?.solverStatus === "string" ? result.solverStatus : "OK";

      deps.updatePlanMeta(els, result.initialSoc_percent, result.tsStart);
      deps.updateSummaryUI(els, result.summary);
      deps.updateRebalanceNudgeUI(els, result.rebalanceNudge);
      updateRunStatus(solverStatus, writeToVictron);

      const cfgForViz = getVizConfig();
      const evSettings = getEvSettings();

      lastTableRows = rows;
      lastTableRebalanceWindow = result.rebalanceWindow ?? null;
      lastPricesKnownUntilMs = result.pricesKnownUntilMs ?? null;

      renderVisuals();
      deps.updateEvPanel(els, rows, result.summary, cfgForViz.stepSize_m, evSettings);
      onPlanRows(rows);
    } catch (err) {
      console.error(err);
      if (els.status) {
        els.status.textContent = `Error: ${err.message}`;
        els.status.className = "text-sm font-medium text-red-600 dark:text-red-400";
      }
      deps.updateSummaryUI(els, null);
    } finally {
      if (runBtn) {
        runBtn.classList.remove('loading');
        runBtn.disabled = false;
      }
    }
  }

  function onTableDisplayChange(event) {
    if (!renderScheduleTable()) {
      void onRun();
      return;
    }
    if (event?.currentTarget === els.tableKwh) {
      queuePersistSnapshot();
    }
  }

  // The rows currently shown: the full plan, or its standard-window prefix.
  function getVisibleRows() {
    if (!lastTableRows.length) return { rows: [], view: "standard", hasExtended: false };
    const hasExtended = planExceedsStandardView(lastTableRows);
    const view = hasExtended ? getStoredViewRange() : "standard";
    const rows = view === "full" ? lastTableRows : sliceRowsToStandardView(lastTableRows);
    return { rows, view, hasExtended };
  }

  function renderScheduleTable() {
    if (!lastTableRows.length) return false;
    const { rows } = getVisibleRows();
    deps.renderTable({
      rows,
      cfg: getVizConfig(),
      targets: { table: els.table, tableUnit: els.tableUnit },
      showKwh: !!els.tableKwh?.checked,
      showDess: !!els.tableDess?.checked,
      rebalanceWindow: clampRebalanceWindow(lastTableRebalanceWindow, rows.length),
      evSettings: getEvSettings(),
    });
    return true;
  }

  // Re-render charts + table from the cached plan (no solve).
  function renderVisuals() {
    if (!lastTableRows.length) return false;
    const cfg = getVizConfig();
    const evSettings = getEvSettings();
    const { rows, view, hasExtended } = getVisibleRows();
    const rebalanceWindow = clampRebalanceWindow(lastTableRebalanceWindow, rows.length);

    // Hourly bars keep the multi-day view readable; the standard view always
    // uses native slots. Default to hourly beyond 48 h unless the user chose.
    const spanH = rowsSpanHours(rows);
    const canAggregate = spanH > 48;
    const resolution = canAggregate ? (getStoredFlowsResolution() ?? "60") : "15";

    updateViewToggleUI(hasExtended, view, canAggregate, resolution);

    if (resolution === "60") {
      const hourlyRows = aggregateRowsHourly(rows, cfg.stepSize_m);
      deps.drawFlowsBarStackSigned(
        els.flows, hourlyRows, 60,
        mapRebalanceWindowToRows(rebalanceWindow, rows, hourlyRows),
        evSettings,
      );
    } else {
      deps.drawFlowsBarStackSigned(els.flows, rows, cfg.stepSize_m, rebalanceWindow, evSettings);
    }
    deps.drawSocChart(els.soc, rows, cfg.stepSize_m, evSettings);
    deps.drawPricesStepLines(els.prices, rows, cfg.stepSize_m, lastPricesKnownUntilMs);
    deps.drawLoadPvGrouped(els.loadpv, rows, cfg.stepSize_m);
    renderScheduleTable();
    return true;
  }

  const SEG_ACTIVE = "rounded-full px-2.5 py-1 text-xs font-medium bg-white text-ink shadow-sm dark:bg-slate-700 dark:text-slate-100 transition-all";
  const SEG_INACTIVE = "rounded-full px-2.5 py-1 text-xs font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 transition-all";

  function setSegState(btn, active) {
    if (!btn) return;
    btn.className = active ? SEG_ACTIVE : SEG_INACTIVE;
    btn.setAttribute("aria-pressed", String(active));
  }

  function updateViewToggleUI(hasExtended, view, canAggregate, resolution) {
    if (els.viewRangeToggle) els.viewRangeToggle.hidden = !hasExtended;
    setSegState(els.viewRangeStandard, view === "standard");
    setSegState(els.viewRangeFull, view === "full");
    if (els.flowsResToggle) els.flowsResToggle.hidden = !canAggregate;
    setSegState(els.flowsRes15, resolution === "15");
    setSegState(els.flowsRes60, resolution === "60");
  }

  function onViewRangeChange(range) {
    storeViewRange(range);
    renderVisuals();
  }

  function onFlowsResolutionChange(resolution) {
    storeFlowsResolution(resolution);
    renderVisuals();
  }

  async function persistConfig(cfg = deps.snapshotUI(els)) {
    try {
      await deps.saveConfig(cfg);
    } catch (error) {
      console.error("Failed to persist settings", error);
      if (els.status) els.status.textContent = `Settings error: ${error.message}`;
    }
  }

  function queuePersistSnapshot() {
    persistConfigDebounced(deps.snapshotUI(els));
  }

  function updateRunStatus(solverStatus, writeToVictron) {
    if (!els.status) return;

    const nonOptimal =
      typeof solverStatus === "string" &&
      solverStatus.toLowerCase() !== "optimal";

    let label;
    let colorClass = "text-emerald-600 dark:text-emerald-400";

    if (nonOptimal) {
      label = `Plan status: ${solverStatus}`;
      colorClass = "text-amber-600 dark:text-amber-400";
    } else if (writeToVictron) {
      label = "Plan updated and sent to Victron";
    } else {
      label = "Plan updated";
    }
    els.status.textContent = label;
    els.status.className = `text-sm font-medium ${colorClass}`;
  }

  function getVizConfig() {
    return {
      stepSize_m: Number(els.step?.value),
      batteryCapacity_Wh: Number(els.cap?.value),
    };
  }

  function getEvSettings() {
    if (!els.evEnabled?.checked) return null;
    const buffer = Number(els.evTripSocBuffer?.value);
    return collectEvSettings(getEvEntries(), Number.isFinite(buffer) ? buffer : 20);
  }

  return {
    debounceRun,
    onRun,
    onTableDisplayChange,
    onViewRangeChange,
    onFlowsResolutionChange,
    persistConfig,
    persistConfigDebounced,
    queuePersistSnapshot,
    renderScheduleTable,
    renderVisuals,
  };
}
