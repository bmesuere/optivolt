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
import { updateEvPanel } from "./ev-tab.js";
import { updateEvDepartureQuickSet } from "./ev-settings.js";
import {
  snapshotUI,
  updatePlanMeta,
  updateSummaryUI,
} from "./state.js";

export function createOptimizerController({ els, services = {} }) {
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
    updateEvDepartureQuickSet,
    updateEvPanel,
    updatePlanMeta,
    updateSummaryUI,
    ...services,
  };

  let lastTableRows = [];
  let lastTableRebalanceWindow = null;

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
      updateRunStatus(solverStatus, writeToVictron);

      const cfgForViz = getVizConfig();
      const evSettings = getEvSettings();

      lastTableRows = rows;
      lastTableRebalanceWindow = result.rebalanceWindow ?? null;
      renderScheduleTable();

      renderAllCharts(rows, cfgForViz, result.rebalanceWindow ?? null, evSettings);
      deps.updateEvPanel(els, rows, result.summary, cfgForViz.stepSize_m);
      deps.updateEvDepartureQuickSet(els, rows);
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

  function renderScheduleTable() {
    if (!lastTableRows.length) return false;
    deps.renderTable({
      rows: lastTableRows,
      cfg: getVizConfig(),
      targets: { table: els.table, tableUnit: els.tableUnit },
      showKwh: !!els.tableKwh?.checked,
      showDess: !!els.tableDess?.checked,
      rebalanceWindow: lastTableRebalanceWindow,
      evSettings: getEvSettings(),
    });
    return true;
  }

  function renderAllCharts(rows, cfg, rebalanceWindow = null, evSettings = null) {
    deps.drawFlowsBarStackSigned(els.flows, rows, cfg.stepSize_m, rebalanceWindow, evSettings);
    deps.drawSocChart(els.soc, rows, cfg.stepSize_m, evSettings);
    deps.drawPricesStepLines(els.prices, rows, cfg.stepSize_m);
    deps.drawLoadPvGrouped(els.loadpv, rows, cfg.stepSize_m);
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
    return els.evEnabled?.checked ? {
      departureTime: els.evDepartureTime?.value || null,
      targetSoc_percent: parseFloat(els.evTargetSoc?.value) || null,
    } : null;
  }

  return {
    debounceRun,
    onRun,
    onTableDisplayChange,
    persistConfig,
    persistConfigDebounced,
    queuePersistSnapshot,
    renderScheduleTable,
  };
}
