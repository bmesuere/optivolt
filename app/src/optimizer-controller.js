import {
  drawFlowsBarStackSigned,
  drawSocChart,
  drawPricesStepLines,
  drawLoadPvGrouped,
} from "./charts.js";
import { renderTable } from "./table.js";
import { debounce } from "./utils.js";
import { saveConfig } from "./config-store.js";
import { fetchLastPlan, requestRemoteSolve } from "./api/api.js";
import { updateEvPanel, collectEvSettings, initEvPanelToggles } from "./ev-tab.js";
import {
  snapshotUI,
  updatePlanMeta,
  updateRebalanceNudgeUI,
  updateSummaryUI,
} from "./state.js";
import { resolvePlanView } from "./plan-view.js";
import {
  beginPlanRequest,
  getPlan,
  isCurrentPlanRequest,
  setPlan,
  subscribePlan,
} from "./plan-store.js";
import { mountViewToggles, subscribeViewToggles } from "./view-toggles.js";
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
    fetchLastPlan,
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

  const viewToggles = mountViewToggles(els.optimizerViewToggles);
  initEvPanelToggles(els);
  subscribeViewToggles(() => { renderVisuals(); });

  // Everything the plan drives is painted from the store, so a plan set from
  // anywhere (fresh solve, boot's cached fetch) renders the same way.
  subscribePlan(renderPlan);

  // The "Now" block follows the wall clock, not the plan's first row, so it
  // keeps pointing at the right slot without a page reload.
  startNowPanelTicker(() => renderNowPanel(els, {
    rows: getPlan().rows,
    stepSize_m: getVizConfig().stepSize_m,
    initialSoc_percent: getPlan().initialSoc_percent,
  }));

  const debounceRun = deps.debounce(onRun, 250);
  const persistConfigDebounced = deps.debounce((cfg) => {
    void persistConfig(cfg);
  }, 600);

  // Render everything that derives from the plan: meta, summary, charts,
  // table, Now panel, EV panel.
  function renderPlan(plan) {
    const { rows } = plan;

    // Plan end is the last planned slot's start, not the boundary after it.
    deps.updatePlanMeta(els, plan.tsStart, rows[rows.length - 1]?.timestampMs ?? null);
    deps.updateSummaryUI(els, plan.summary);
    deps.updateRebalanceNudgeUI(els, plan.rebalanceNudge);

    const cfgForViz = getVizConfig();

    renderVisuals();
    renderNowPanel(els, {
      rows,
      stepSize_m: cfgForViz.stepSize_m,
      initialSoc_percent: plan.initialSoc_percent,
    });
    deps.updateEvPanel(els, rows, plan.summary, cfgForViz.stepSize_m, getEvSettings());
    onPlanRows(rows);
  }

  // Show the server's cached plan (if it still covers now) instead of solving
  // on page load. Returns the fetched payload so the caller can judge whether
  // a fresh solve is still warranted, or null — cheaply, without touching the
  // UI — when there is nothing usable to show.
  async function loadLastPlan() {
    const seq = beginPlanRequest();
    let result;
    try {
      result = await deps.fetchLastPlan();
    } catch {
      return null;
    }
    if (!isCurrentPlanRequest(seq)) return null;
    if (!Array.isArray(result?.rows) || result.rows.length === 0) return null;

    setPlan(result);
    if (els.status) {
      els.status.textContent = "Loaded existing plan";
      els.status.className = "text-sm font-medium text-ink dark:text-slate-100";
    }
    return result;
  }

  async function onRun() {
    if (typeof persistConfigDebounced.cancel === "function") {
      persistConfigDebounced.cancel();
    }

    const seq = beginPlanRequest();

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
      if (!isCurrentPlanRequest(seq)) return;

      const solverStatus =
        typeof result?.solverStatus === "string" ? result.solverStatus : "OK";

      // The plan is solved by now — and, when writeToVictron is set, already written over MQTT.
      // A throw while drawing it is a display failure, not a planning failure, so it must not
      // fall through to the outer catch and wipe a summary that computed fine.
      try {
        updateRunStatus(solverStatus, writeToVictron);
        setPlan(result);
      } catch (renderError) {
        console.error("Failed to render plan", renderError);
        if (els.status) {
          els.status.textContent = `Plan calculated, but display failed: ${renderError.message}`;
          els.status.className = "text-sm font-medium text-amber-600 dark:text-amber-400";
        }
      }
    } catch (err) {
      console.error(err);
      if (!isCurrentPlanRequest(seq)) return;
      if (els.status) {
        els.status.textContent = `Error: ${err.message}`;
        els.status.className = "text-sm font-medium text-red-600 dark:text-red-400";
      }
      setChartPlaceholders(CHART_PLACEHOLDER_IDLE);
      deps.updateSummaryUI(els, null);
    } finally {
      // A superseded run leaves the button alone: the run that replaced it is
      // still in flight and owns the spinner.
      if (runBtn && isCurrentPlanRequest(seq)) {
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

  // What the current plan looks like through the view toggles: visible rows,
  // bar resolution, and the rebalance window remapped onto whatever gets drawn.
  function currentPlanView() {
    const plan = getPlan();
    return resolvePlanView({
      rows: plan.rows,
      stepSize_m: getVizConfig().stepSize_m,
      standardEndMs: plan.standardWindowEndMs,
      rebalanceWindow: plan.rebalanceWindow,
    });
  }

  function renderScheduleTable(planView = currentPlanView()) {
    if (!planView.rows.length) return false;
    deps.renderTable({
      rows: planView.rows,
      cfg: getVizConfig(),
      targets: { table: els.table, tableUnit: els.tableUnit },
      showKwh: !!els.tableKwh?.checked,
      showDess: !!els.tableDess?.checked,
      rebalanceWindow: planView.rebalanceWindow,
      evSettings: getEvSettings(),
    });
    return true;
  }

  // Re-render charts + table from the stored plan (no solve).
  function renderVisuals() {
    const planView = currentPlanView();
    if (!planView.rows.length) return false;
    const { rows, chartRows, chartStepSize_m, chartRebalanceWindow } = planView;
    const cfg = getVizConfig();
    const evSettings = getEvSettings();

    viewToggles.update(planView);

    deps.drawFlowsBarStackSigned(
      els.flows, chartRows, chartStepSize_m, chartRebalanceWindow, evSettings,
    );
    deps.drawSocChart(els.soc, rows, cfg.stepSize_m, evSettings);
    deps.drawPricesStepLines(els.prices, rows, cfg.stepSize_m, getPlan().pricesKnownUntilMs);
    deps.drawLoadPvGrouped(els.loadpv, rows, cfg.stepSize_m);
    renderScheduleTable(planView);
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
    return collectEvSettings(getEvEntries());
  }

  return {
    debounceRun,
    loadLastPlan,
    onRun,
    onTableDisplayChange,
    persistConfig,
    persistConfigDebounced,
    queuePersistSnapshot,
    renderScheduleTable,
    renderVisuals,
  };
}
