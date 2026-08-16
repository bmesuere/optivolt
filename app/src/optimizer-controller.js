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
import { updateEvPanel, collectEvSettings, initEvPanelToggles } from "./ev-tab.js";
import {
  snapshotUI,
  updatePlanMeta,
  updateRebalanceNudgeUI,
  updateSummaryUI,
} from "./state.js";
import {
  aggregateRowsHourly,
  clampRebalanceWindow,
  getStoredViewRange,
  mapRebalanceWindowToRows,
  planExceedsStandardView,
  rowsSpanHours,
  sliceRowsToStandardView,
} from "./plan-view.js";
import {
  mountViewToggles,
  resolveFlowsResolution,
  setStandardWindowEndMs,
  subscribeViewToggles,
} from "./view-toggles.js";
import { renderNowPanel, startNowPanelTicker } from "./now-panel.js";

const CHART_PLACEHOLDER_IDLE = "Run the optimizer to see results";
const PLACEHOLDER_SELECTOR = "#panel-optimizer .chart-empty span, #panel-ev .chart-empty span";

/** Text of the not-yet-drawn chart overlays on the plan-driven tabs. */
function setChartPlaceholders(text) {
  for (const span of document.querySelectorAll(PLACEHOLDER_SELECTOR)) {
    span.textContent = text;
  }
}

export function createOptimizerController({
  els,
  services = {},
  getEvEntries = () => [],
  onPlanRows = () => {},
  onForecastsRefreshed = () => {},
}) {
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
  let lastStandardWindowEndMs = null;
  let lastInitialSoc_percent = null;

  const viewToggles = mountViewToggles(els.optimizerViewToggles);
  initEvPanelToggles(els);
  subscribeViewToggles(() => { renderVisuals(); });

  // The "Now" block follows the wall clock, not the plan's first row, so it
  // keeps pointing at the right slot without a page reload.
  startNowPanelTicker(() => renderNowPanel(els, {
    rows: lastTableRows,
    stepSize_m: getVizConfig().stepSize_m,
    initialSoc_percent: lastInitialSoc_percent,
  }));

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
    // Until the first plan lands the charts are bare placeholders reading
    // "Run the optimizer…", which contradicts the status line while a solve is
    // actually in flight. renderChart hides them for good once it draws.
    setChartPlaceholders("Calculating…");

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

      // Plan end is the last planned slot's start, not the boundary after it.
      deps.updatePlanMeta(els, result.tsStart, rows[rows.length - 1]?.timestampMs ?? null);
      deps.updateSummaryUI(els, result.summary);
      deps.updateRebalanceNudgeUI(els, result.rebalanceNudge);
      updateRunStatus(solverStatus, writeToVictron);

      const cfgForViz = getVizConfig();
      const evSettings = getEvSettings();

      lastTableRows = rows;
      lastInitialSoc_percent = result.initialSoc_percent ?? null;
      lastTableRebalanceWindow = result.rebalanceWindow ?? null;
      lastPricesKnownUntilMs = result.pricesKnownUntilMs ?? null;
      lastStandardWindowEndMs = result.standardWindowEndMs ?? null;
      // Share the server boundary so the EV and forecast tabs slice alike.
      setStandardWindowEndMs(lastStandardWindowEndMs);

      renderVisuals();
      renderNowPanel(els, {
        rows,
        stepSize_m: cfgForViz.stepSize_m,
        initialSoc_percent: lastInitialSoc_percent,
      });
      deps.updateEvPanel(els, rows, result.summary, cfgForViz.stepSize_m, evSettings);
      onPlanRows(rows);
    } catch (err) {
      console.error(err);
      if (els.status) {
        els.status.textContent = `Error: ${err.message}`;
        els.status.className = "text-sm font-medium text-red-600 dark:text-red-400";
      }
      setChartPlaceholders(CHART_PLACEHOLDER_IDLE);
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
  // The boundary comes from the server (plan timezone); browser-local fallback.
  function getVisibleRows() {
    if (!lastTableRows.length) return { rows: [], view: "standard", hasExtended: false };
    const hasExtended = planExceedsStandardView(lastTableRows, lastStandardWindowEndMs);
    const view = hasExtended ? getStoredViewRange() : "standard";
    const rows = view === "full"
      ? lastTableRows
      : sliceRowsToStandardView(lastTableRows, lastStandardWindowEndMs);
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

    // Hourly bars keep multi-day views readable, so that is the default beyond
    // 48 h — but the control is always available, whatever the span.
    const resolution = resolveFlowsResolution(rowsSpanHours(rows));

    viewToggles.update({ hasExtended, view, resolution });

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

  async function persistConfig(cfg = deps.snapshotUI(els)) {
    try {
      const result = await deps.saveConfig(cfg);
      // Changing the horizon makes the server regenerate the load/PV forecasts.
      // The Predictions tab caches those series, so it has to re-read them or
      // it keeps charting the old window until a manual run or a reload.
      if (result?.forecastsRefreshed) await onForecastsRefreshed();
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
    persistConfig,
    persistConfigDebounced,
    queuePersistSnapshot,
    renderScheduleTable,
    renderVisuals,
  };
}
