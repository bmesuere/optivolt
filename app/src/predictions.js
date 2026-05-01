/**
 * predictions.js
 *
 * Coordinator for the Predictions tab.
 */

import {
  fetchStoredData,
  runPvForecast,
  runCombinedForecast,
} from './api/api.js';
import {
  applyAdjustmentsToForecastSeries,
  futureForecastSeries,
} from './predictions/forecast-series.js';
import { renderLoadAccuracyChart, renderPvAccuracyChart } from './predictions/accuracy-charts.js';
import {
  hydratePredictionForm,
  savePredictionFormToServer,
  wirePredictionForm,
} from './predictions/config-form.js';
import { createForecastChartController } from './predictions/forecast-chart.js';

export {
  applyAdjustmentsToForecastSeries,
  buildForecastSelectionRange,
  forecastSeriesFromCategoryX,
  futureForecastSeries,
} from './predictions/forecast-series.js';

let lastLoadForecast = null;
let lastPvForecast = null;
let lastLoadForecastRaw = null;
let lastPvForecastRaw = null;

const forecastChart = createForecastChartController({
  getForecasts: () => ({
    load: lastLoadForecast,
    pv: lastPvForecast,
    rawLoad: lastLoadForecastRaw,
    rawPv: lastPvForecastRaw,
  }),
  onAdjustmentsChanged: refreshAdjustedForecastsFromRaw,
});

export async function initPredictionsTab() {
  await hydratePredictionForm();
  await forecastChart.loadAdjustments();
  await hydrateForecastsFromStoredData();
  wirePredictionForm({
    onForecastAll,
    onPvForecast,
    onForecastResolutionChange: forecastChart.render,
  });
  forecastChart.wireAdjustmentPopover();
  onForecastAll();
}

function refreshAdjustedForecastsFromRaw() {
  const predictionAdjustments = forecastChart.getAdjustments();
  lastLoadForecast = lastLoadForecastRaw
    ? applyAdjustmentsToForecastSeries(lastLoadForecastRaw, predictionAdjustments, 'load')
    : null;
  lastPvForecast = lastPvForecastRaw
    ? applyAdjustmentsToForecastSeries(lastPvForecastRaw, predictionAdjustments, 'pv')
    : null;
}

async function hydrateForecastsFromStoredData() {
  try {
    const data = await fetchStoredData();
    const load = futureForecastSeries(data?.load);
    const pv = futureForecastSeries(data?.pv);
    if (!load && !pv) return;

    lastLoadForecastRaw = load;
    lastPvForecastRaw = pv;
    refreshAdjustedForecastsFromRaw();
    forecastChart.render();
    if (load) updateStoredForecastMetrics('load', load, lastLoadForecast);
    if (pv) updateStoredForecastMetrics('pv', pv, lastPvForecast);
  } catch (err) {
    console.error('Failed to load stored forecast data:', err);
  }
}

async function onForecastAll() {
  updateStatus('load', 'Running load forecast…');
  updateStatus('pv', 'Running PV forecast…');

  try {
    await savePredictionFormToServer();
    const result = await runCombinedForecast();
    updateForecastUI('load', result.load);
    updateForecastUI('pv', result.pv);
  } catch (err) {
    console.error(err);
    updateStatus('load', 'Error: ' + err.message, true);
    updateStatus('pv', 'Error: ' + err.message, true);
  }
}

async function onPvForecast() {
  updateStatus('pv', 'Running PV forecast…');

  try {
    await savePredictionFormToServer();
    const result = await runPvForecast();
    updateForecastUI('pv', result);
  } catch (err) {
    console.error(err);
    updateStatus('pv', 'Error: ' + err.message, true);
  }
}

function updateForecastUI(type, result) {
  const label = type === 'load' ? 'Load' : 'PV';
  if (!result) {
    updateStatus(type, `${label} forecast skipped`);
    return;
  }

  if (type === 'load') {
    lastLoadForecastRaw = result.rawForecast ?? result.forecast ?? null;
    lastLoadForecast = result.forecast ?? null;
    renderLoadAccuracyChart(result.recent);
  } else {
    lastPvForecastRaw = result.rawForecast ?? result.forecast ?? null;
    lastPvForecast = result.forecast ?? null;
    renderPvAccuracyChart(result.recent);
  }
  refreshAdjustedForecastsFromRaw();
  forecastChart.render();
  updateMetrics(type, result);
  updateStatus(type, `${label} forecast updated`);
}

function updateStatus(prefix, msg, isError = false) {
  const el = document.getElementById(`${prefix}-summary-status`);
  if (!el) return;
  el.textContent = msg;
  el.className = isError
    ? 'text-sm font-medium text-red-600 dark:text-red-400'
    : 'text-sm font-medium text-emerald-600 dark:text-emerald-400';
}

function updateMetrics(prefix, resultObject) {
  if (!resultObject || !resultObject.forecast) return;

  const values = resultObject.forecast.values || [];
  const peak = values.length ? Math.max(...values) : 0;
  const min = prefix === 'load' && values.length ? Math.min(...values) : 0;
  const totalKwh = values.reduce((a, b) => a + b, 0) * 0.25 / 1000;
  const avgErrorW = resultObject.metrics?.mae ?? 0;

  setEl(`${prefix}-summary-total`, totalKwh.toFixed(1));
  setEl(`${prefix}-summary-peak`, Math.round(peak).toLocaleString());
  setEl(`${prefix}-summary-error`, Math.round(avgErrorW).toLocaleString());
  if (prefix === 'load') {
    setEl(`${prefix}-summary-min`, Math.round(min).toLocaleString());
  }
}

function updateStoredForecastMetrics(prefix, rawForecast, adjustedForecast) {
  updateMetrics(prefix, { forecast: adjustedForecast ?? rawForecast, metrics: { mae: NaN } });
  setEl(`${prefix}-summary-error`, '--');
  updateStatus(prefix, 'Stored data loaded');
}

function setEl(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
