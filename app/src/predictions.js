/* global Chart */
/**
 * predictions.js
 *
 * Self-contained browser module for the Predictions tab.
 */

import {
  fetchPredictionConfig,
  savePredictionConfig,
  runValidation,
  runPvForecast,
  runCombinedForecast,
} from './api/api.js';
import { debounce } from './utils.js';
import { buildTimeAxisFromTimestamps, getBaseOptions, renderChart, toRGBA, SOLUTION_COLORS } from './charts.js';

const PV_COLOR = 'rgb(247, 171, 62)'; // amber — Solar to Grid

let validationResults = null;
let _activeSensor = null;
let accuracyChart = null;

export async function initPredictionsTab() {
  await hydrateForm();
  wireForm();
  onForecastAll();
}

// ---------------------------------------------------------------------------
// Chart helpers
// ---------------------------------------------------------------------------

const stripe = (c) => window.pattern?.draw('diagonal', c) || c;

/** Aggregate a 15-min ForecastSeries into { timestamps[], hourlyKwh[] }. */
function aggregateHourlyKwh(forecast) {
  const hourMap = new Map();
  const values = forecast.values || [];
  const startTs = new Date(forecast.start).getTime();
  const stepMs = (forecast.step || 15) * 60 * 1000;

  for (let i = 0; i < values.length; i++) {
    const ts = startTs + i * stepMs;
    const dt = new Date(ts);
    dt.setMinutes(0, 0, 0, 0);
    const hourKey = dt.getTime();
    if (!hourMap.has(hourKey)) hourMap.set(hourKey, 0);
    hourMap.set(hourKey, hourMap.get(hourKey) + values[i] * (stepMs / 3600000));
  }

  const timestamps = [...hourMap.keys()].sort((a, b) => a - b);
  const hourlyKwh = timestamps.map(k => hourMap.get(k) / 1000);
  return { timestamps, hourlyKwh };
}

// ---------------------------------------------------------------------------
// Form hydration
// ---------------------------------------------------------------------------

async function hydrateForm() {
  try {
    const config = await fetchPredictionConfig();
    applyConfigToForm(config);
  } catch (err) {
    console.error('Failed to load prediction config:', err);
  }
}

function applyConfigToForm(config) {
  const haSettingsGroup = document.getElementById('pred-ha-settings-group');
  const haSettingsDivider = document.getElementById('pred-ha-settings-divider');
  if (haSettingsGroup) {
    if (config.isAddon) {
      haSettingsGroup.hidden = true;
      if (haSettingsDivider) haSettingsDivider.hidden = true;
    } else {
      haSettingsGroup.hidden = false;
      if (haSettingsDivider) haSettingsDivider.hidden = false;
      setVal('pred-ha-url', config.haUrl ?? '');
      setVal('pred-ha-token', config.haToken ?? '');
    }
  }

  setVal('pred-sensors', config.sensors ? JSON.stringify(config.sensors, null, 2) : '');
  setVal('pred-derived', config.derived ? JSON.stringify(config.derived, null, 2) : '');

  // Populate both sensor dropdowns from the same list
  const allSensors = [...(config.sensors || []), ...(config.derived || [])];

  for (const selectId of ['pred-active-sensor', 'pred-pv-sensor']) {
    const select = document.getElementById(selectId);
    if (!select) continue;
    select.innerHTML = '<option value="" disabled selected>Select a sensor…</option>';
    for (const s of allSensors) {
      const opt = document.createElement('option');
      opt.textContent = s.name || s.id;
      opt.value = opt.textContent;
      select.appendChild(opt);
    }
  }

  renderLoadConfig(config.activeConfig ?? null);
  renderPvConfig(config.pvConfig ?? null);
}

// ---------------------------------------------------------------------------
// Wire form inputs
// ---------------------------------------------------------------------------

function wireForm() {
  const debouncedSave = debounce(saveFormToServer, 600);

  for (const el of document.querySelectorAll('[data-predictions-only="true"]')) {
    el.addEventListener('input', debouncedSave);
    el.addEventListener('change', debouncedSave);
  }

  document.getElementById('pred-run-validation')
    ?.addEventListener('click', onRunValidation);
  document.getElementById('pred-load-forecast')
    ?.addEventListener('click', onForecastAll);
  document.getElementById('pred-pv-forecast')
    ?.addEventListener('click', onPvForecast);

  const settingsToggle = document.getElementById('pred-settings-toggle');
  const settingsBody = document.getElementById('pred-settings-body');
  const settingsIcon = document.getElementById('pred-settings-toggle-icon');

  if (settingsToggle && settingsBody) {
    settingsToggle.addEventListener('click', () => {
      const isHidden = settingsBody.classList.contains('hidden');
      settingsBody.classList.toggle('hidden', !isHidden);
      if (settingsIcon) {
        settingsIcon.style.transform = isHidden ? 'rotate(180deg)' : '';
      }
    });
  }
}

async function saveFormToServer() {
  try {
    const partial = readFormValues();
    await savePredictionConfig(partial);
  } catch (err) {
    console.error('Failed to save prediction config:', err);
  }
}

function readFormValues() {
  const sensors = parseSilently(getVal('pred-sensors'));
  const derived = parseSilently(getVal('pred-derived'));

  const activeSensor = getVal('pred-active-sensor');
  const activeLookback = getVal('pred-active-lookback');

  const activeConfig = activeSensor ? {
    sensor: activeSensor,
    lookbackWeeks: activeLookback ? parseInt(activeLookback, 10) : 4,
    dayFilter: getVal('pred-active-filter') || 'same',
    aggregation: getVal('pred-active-agg') || 'mean',
  } : null;

  const pvConfig = {
    pvSensor: getVal('pred-pv-sensor') || 'Solar Generation',
    latitude: parseFloat(getVal('pred-pv-lat')) || 0,
    longitude: parseFloat(getVal('pred-pv-lon')) || 0,
    historyDays: parseInt(getVal('pred-pv-history'), 10) || 14,
  };

  return {
    haUrl: getVal('pred-ha-url'),
    haToken: getVal('pred-ha-token'),
    ...(sensors !== null ? { sensors } : {}),
    ...(derived !== null ? { derived } : {}),
    ...(activeConfig ? { activeConfig } : {}),
    pvConfig,
  };
}

// ---------------------------------------------------------------------------
// Combined forecast (runs on init and "Forecast Load" button)
// ---------------------------------------------------------------------------

async function onForecastAll() {
  updateLoadStatus('Running load forecast…');
  updatePvStatus('Running PV forecast…');

  try {
    const partial = readFormValues();
    await savePredictionConfig(partial);

    const result = await runCombinedForecast();

    // Load
    if (result.load) {
      renderLoadForecastChart(result.load);
      renderLoadAccuracyChart(result.load.recent);
      updateLoadMetrics(result.load);
      updateLoadStatus('Load forecast updated');
    } else {
      updateLoadStatus('Load forecast skipped');
    }

    // PV
    if (result.pv) {
      renderPvForecastChart(result.pv);
      renderPvAccuracyChart(result.pv.recent);
      updatePvMetrics(result.pv);
      updatePvStatus('PV forecast updated');
    } else {
      updatePvStatus('PV forecast skipped');
    }
  } catch (err) {
    console.error(err);
    updateLoadStatus('Error: ' + err.message, true);
    updatePvStatus('Error: ' + err.message, true);
  }
}

// ---------------------------------------------------------------------------
// PV-only forecast ("Forecast PV" button)
// ---------------------------------------------------------------------------

async function onPvForecast() {
  updatePvStatus('Running PV forecast…');

  try {
    const partial = readFormValues();
    await savePredictionConfig(partial);

    const result = await runPvForecast();

    renderPvForecastChart(result);
    renderPvAccuracyChart(result.recent);
    updatePvMetrics(result);
    updatePvStatus('PV forecast updated');
  } catch (err) {
    console.error(err);
    updatePvStatus('Error: ' + err.message, true);
  }
}

// ---------------------------------------------------------------------------
// Load: status, metrics, charts
// ---------------------------------------------------------------------------

function updateLoadStatus(msg, isError = false) {
  const el = document.getElementById('load-summary-status');
  if (!el) return;
  el.textContent = msg;
  el.className = isError
    ? 'text-sm font-medium text-red-600 dark:text-red-400'
    : 'text-sm font-medium text-emerald-600 dark:text-emerald-400';
}

function updateLoadMetrics(loadResult) {
  const values = loadResult.forecast?.values || [];
  const peak = values.length ? Math.max(...values) : 0;
  const min = values.length ? Math.min(...values) : 0;
  const totalKwh = values.reduce((a, b) => a + b, 0) * 0.25 / 1000;

  let avgErrorW = 0;
  const recent = loadResult.recent || [];
  const valid = recent.filter(r => r.actual != null && r.predicted != null);
  if (valid.length > 0) {
    avgErrorW = valid.reduce((acc, r) => acc + Math.abs(r.actual - r.predicted), 0) / valid.length;
  }

  setEl('load-summary-total', totalKwh.toFixed(1));
  setEl('load-summary-peak', Math.round(peak).toLocaleString());
  setEl('load-summary-min', Math.round(min).toLocaleString());
  setEl('load-summary-error', Math.round(avgErrorW).toLocaleString());
}

function renderLoadForecastChart({ forecast }) {
  const canvas = document.getElementById('load-forecast-chart');
  if (!canvas) return;

  const { timestamps, hourlyKwh } = aggregateHourlyKwh(forecast);
  const axis = buildTimeAxisFromTimestamps(timestamps);

  renderChart(canvas, {
    type: 'bar',
    data: {
      labels: axis.labels,
      datasets: [{
        label: 'Load Forecast',
        data: hourlyKwh,
        backgroundColor: stripe(SOLUTION_COLORS.g2l),
        borderColor: SOLUTION_COLORS.g2l,
        borderWidth: 1,
        hoverBackgroundColor: stripe(toRGBA(SOLUTION_COLORS.g2l, 0.6)),
      }]
    },
    options: getBaseOptions({ ...axis, yTitle: 'kWh' })
  });
}

function renderLoadAccuracyChart(recentData) {
  const canvas = document.getElementById('load-accuracy-chart');
  if (!canvas || !recentData || recentData.length === 0) return;

  const sorted = [...recentData].sort((a, b) => a.time - b.time);
  const axis = buildTimeAxisFromTimestamps(sorted.map(d => d.time));

  renderChart(canvas, {
    type: 'line',
    data: {
      labels: axis.labels,
      datasets: [
        {
          label: 'Actual',
          data: sorted.map(d => d.actual / 1000),
          borderColor: 'transparent',
          backgroundColor: toRGBA(SOLUTION_COLORS.b2l, 0.25),
          borderWidth: 0,
          pointRadius: 0,
          tension: 0.3,
          fill: true,
        },
        {
          label: 'Prediction',
          data: sorted.map(d => d.predicted / 1000),
          borderColor: SOLUTION_COLORS.g2l,
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.3,
          fill: false,
        },
      ]
    },
    options: getBaseOptions({ ...axis, yTitle: 'kWh' }),
  });
}

// ---------------------------------------------------------------------------
// PV: status, metrics, charts
// ---------------------------------------------------------------------------

function updatePvStatus(msg, isError = false) {
  const el = document.getElementById('pv-summary-status');
  if (!el) return;
  el.textContent = msg;
  el.className = isError
    ? 'text-sm font-medium text-red-600 dark:text-red-400'
    : 'text-sm font-medium text-emerald-600 dark:text-emerald-400';
}

function updatePvMetrics(pvResult) {
  if (!pvResult || !pvResult.forecast) return;

  const values = pvResult.forecast.values || [];
  const peak = values.length ? Math.max(...values) : 0;
  const totalKwh = values.reduce((a, b) => a + b, 0) * 0.25 / 1000;
  const avgError = pvResult.metrics?.mae ?? 0;

  setEl('pv-summary-total', totalKwh.toFixed(1));
  setEl('pv-summary-peak', Math.round(peak).toLocaleString());
  setEl('pv-summary-error', Math.round(avgError).toLocaleString());
}

function renderPvForecastChart(result) {
  const canvas = document.getElementById('pv-forecast-chart');
  if (!canvas || !result?.forecast) return;

  const { timestamps, hourlyKwh } = aggregateHourlyKwh(result.forecast);
  const axis = buildTimeAxisFromTimestamps(timestamps);

  renderChart(canvas, {
    type: 'bar',
    data: {
      labels: axis.labels,
      datasets: [{
        label: 'PV Forecast',
        data: hourlyKwh,
        backgroundColor: stripe(PV_COLOR),
        borderColor: PV_COLOR,
        borderWidth: 1,
      }]
    },
    options: getBaseOptions({ ...axis, yTitle: 'kWh' })
  });
}

function renderPvAccuracyChart(recentData) {
  const canvas = document.getElementById('pv-accuracy-chart');
  if (!canvas || !recentData || recentData.length === 0) return;

  const sorted = [...recentData].sort((a, b) => a.time - b.time);
  const axis = buildTimeAxisFromTimestamps(sorted.map(d => d.time));

  renderChart(canvas, {
    type: 'line',
    data: {
      labels: axis.labels,
      datasets: [
        {
          label: 'Actual',
          data: sorted.map(d => (d.actual_Wh ?? 0) / 1000),
          borderColor: 'transparent',
          backgroundColor: toRGBA(SOLUTION_COLORS.pv2b, 0.25),
          borderWidth: 0,
          pointRadius: 0,
          tension: 0.3,
          fill: true,
        },
        {
          label: 'Predicted',
          data: sorted.map(d => (d.prediction_Wh ?? 0) / 1000),
          borderColor: PV_COLOR,
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.3,
          fill: false,
        },
      ],
    },
    options: getBaseOptions({ ...axis, yTitle: 'kWh' }),
  });
}

// ---------------------------------------------------------------------------
// Config display
// ---------------------------------------------------------------------------

function renderLoadConfig(activeConfig) {
  if (!activeConfig) return;
  setVal('pred-active-sensor', activeConfig.sensor ?? '');
  setVal('pred-active-lookback', activeConfig.lookbackWeeks ?? '');
  setVal('pred-active-filter', activeConfig.dayFilter ?? '');
  setVal('pred-active-agg', activeConfig.aggregation ?? '');
}

function renderPvConfig(pvConfig) {
  if (!pvConfig) return;
  setVal('pred-pv-sensor', pvConfig.pvSensor ?? '');
  setVal('pred-pv-lat', pvConfig.latitude ?? '');
  setVal('pred-pv-lon', pvConfig.longitude ?? '');
  setVal('pred-pv-history', pvConfig.historyDays ?? 14);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

async function onRunValidation() {
  const runBtn = document.getElementById('pred-run-validation');
  const originalText = runBtn ? runBtn.textContent : '';
  if (runBtn) {
    runBtn.disabled = true;
    runBtn.textContent = 'Running...';
    runBtn.classList.add('opacity-50', 'cursor-not-allowed');
  }

  try {
    const resultsEl = document.getElementById('pred-results');

    setComparisonStatus('Saving config…');

    try {
      const partial = readFormValues();
      await savePredictionConfig(partial);
    } catch (err) {
      setComparisonStatus(`Save failed: ${err.message}`, true);
      return;
    }

    setComparisonStatus('Fetching HA data and running validation…');
    if (resultsEl) resultsEl.hidden = true;
    const noResultsEl = document.getElementById('pred-no-results');
    if (noResultsEl) noResultsEl.hidden = true;

    try {
      const result = await runValidation();
      validationResults = result;
      renderResults(result);
      setComparisonStatus(`Validation complete — ${result.results.length} combinations evaluated`);
    } catch (err) {
      setComparisonStatus(`Error: ${err.message}`, true);
    }
  } finally {
    if (runBtn) {
      runBtn.disabled = false;
      runBtn.textContent = originalText;
      runBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    }
  }
}

// ---------------------------------------------------------------------------
// Render validation results
// ---------------------------------------------------------------------------

function renderResults({ sensorNames, results }) {
  const resultsEl = document.getElementById('pred-results');
  if (!resultsEl) return;

  resultsEl.hidden = false;

  const noResultsEl = document.getElementById('pred-no-results');
  if (noResultsEl) noResultsEl.hidden = true;

  renderSensorTabs(sensorNames);

  const firstSensor = sensorNames[0] ?? null;
  if (firstSensor) {
    _activeSensor = firstSensor;
    renderMetricsTable(results, firstSensor);
  }
}

function renderSensorTabs(sensorNames) {
  const container = document.getElementById('pred-sensor-tabs');
  if (!container) return;

  container.innerHTML = '';
  for (const name of sensorNames) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = name;
    btn.dataset.sensor = name;
    btn.className =
      'px-3 py-1.5 text-sm rounded-pill border border-slate-300 dark:border-white/10 ' +
      'focus:outline-none focus:ring-2 focus:ring-sky-400/30 transition-colors';
    btn.addEventListener('click', () => {
      _activeSensor = name;
      renderMetricsTable(validationResults.results, name);
      updateTabActive(container, name);
    });
    container.appendChild(btn);
  }

  updateTabActive(container, sensorNames[0] ?? null);
}

function updateTabActive(container, activeName) {
  for (const btn of container.querySelectorAll('button')) {
    const isActive = btn.dataset.sensor === activeName;
    btn.classList.toggle('bg-sky-600', isActive);
    btn.classList.toggle('text-white', isActive);
    btn.classList.toggle('border-sky-600', isActive);
    btn.classList.toggle('hover:bg-sky-700', isActive);
    btn.classList.toggle('bg-white', !isActive);
    btn.classList.toggle('dark:bg-slate-800', !isActive);
    btn.classList.toggle('text-slate-700', !isActive);
    btn.classList.toggle('dark:text-slate-200', !isActive);
    btn.classList.toggle('hover:bg-slate-50', !isActive);
    btn.classList.toggle('dark:hover:bg-slate-700', !isActive);
  }
}

function renderMetricsTable(results, sensorName) {
  const tbody = document.getElementById('pred-metrics-body');
  if (!tbody) return;

  const rows = results
    .filter(r => r.sensor === sensorName)
    .sort((a, b) => (isNaN(a.mae) ? 1 : isNaN(b.mae) ? -1 : a.mae - b.mae));

  tbody.innerHTML = '';
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.className = 'border-t border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-slate-800/50';
    tr.innerHTML = `
      <td class="px-3 py-2 font-mono text-xs">${row.lookbackWeeks}w</td>
      <td class="px-3 py-2 text-xs">${row.dayFilter}</td>
      <td class="px-3 py-2 text-xs">${row.aggregation}</td>
      <td class="px-3 py-2 font-mono text-xs text-right">${isNaN(row.mae) ? '—' : row.mae.toFixed(1)}</td>
      <td class="px-3 py-2 font-mono text-xs text-right">${isNaN(row.rmse) ? '—' : row.rmse.toFixed(1)}</td>
      <td class="px-3 py-2 font-mono text-xs text-right">${isNaN(row.mape) ? '—' : row.mape.toFixed(1)}</td>
      <td class="px-3 py-2 font-mono text-xs text-right">${row.n}</td>
      <td class="px-3 py-2">
        <div class="flex gap-1">
          <button type="button" class="btn-use text-xs px-2 py-0.5 rounded border border-sky-500 text-sky-600 hover:bg-sky-50 dark:text-sky-400 dark:border-sky-400 dark:hover:bg-sky-900/30">Use</button>
          <button type="button" class="btn-chart text-xs px-2 py-0.5 rounded border border-slate-300 text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:border-white/20 dark:hover:bg-slate-700">Chart</button>
        </div>
      </td>
    `;

    tr.querySelector('.btn-use').addEventListener('click', () => onUseConfig(row));
    tr.querySelector('.btn-chart').addEventListener('click', () => onShowChart(row));

    tbody.appendChild(tr);
  }
}

async function onUseConfig(row) {
  const activeConfig = {
    sensor: row.sensor,
    lookbackWeeks: row.lookbackWeeks,
    dayFilter: row.dayFilter,
    aggregation: row.aggregation,
  };

  try {
    renderLoadConfig(activeConfig);
    const partial = readFormValues();
    await savePredictionConfig(partial);
    setComparisonStatus(`Active config updated: ${row.sensor} / ${row.lookbackWeeks}w / ${row.dayFilter} / ${row.aggregation}`);
  } catch (err) {
    setComparisonStatus(`Failed to save active config: ${err.message}`, true);
  }
}

function onShowChart(row) {
  const chartSection = document.getElementById('pred-chart-section');
  if (chartSection) chartSection.hidden = false;

  const canvas = document.getElementById('pred-accuracy-chart');
  if (!canvas) return;

  const preds = row.validationPredictions ?? [];
  const labels = preds.map(p => {
    const d = new Date(p.date);
    return `${d.toISOString().slice(5, 10)} ${String(p.hour).padStart(2, '0')}h`;
  });

  if (accuracyChart) {
    accuracyChart.destroy();
    accuracyChart = null;
  }

  accuracyChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Actual (Wh)',
          data: preds.map(p => p.actual),
          borderColor: 'rgb(14, 165, 233)',
          backgroundColor: 'rgba(14, 165, 233, 0.1)',
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
        },
        {
          label: 'Predicted (Wh)',
          data: preds.map(p => p.predicted),
          borderColor: 'rgb(249, 115, 22)',
          backgroundColor: 'rgba(249, 115, 22, 0.1)',
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'top' } },
      scales: { y: { title: { display: true, text: 'Wh' } } },
    },
  });

  const title = document.getElementById('pred-chart-title');
  if (title) {
    title.textContent = `Accuracy: ${row.sensor} / ${row.lookbackWeeks}w / ${row.dayFilter} / ${row.aggregation}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setComparisonStatus(msg, isError = false) {
  const el = document.getElementById('pred-status');
  if (!el) return;
  el.textContent = msg;
  el.className = isError
    ? 'text-sm text-red-600 dark:text-red-400'
    : 'text-sm text-ink-soft dark:text-slate-400';
}

function setEl(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setVal(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

function getVal(id) {
  return document.getElementById(id)?.value ?? '';
}

function parseSilently(str) {
  try { return JSON.parse(str); }
  catch { return null; }
}
