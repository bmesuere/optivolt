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
  fetchForecast,
} from './api/api.js';
import { debounce } from './utils.js';
import { buildTimeAxisFromTimestamps, getBaseOptions, renderChart, SOLUTION_COLORS } from './charts.js';

let validationResults = null;
let _activeSensor = null;
let accuracyChart = null;

export async function initPredictionsTab() {
  await hydrateForm();
  wireForm();

  // Auto-run forecast on load
  onRecompute();
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
  if (haSettingsGroup) {
    if (config.isAddon) {
      haSettingsGroup.hidden = true;
    } else {
      haSettingsGroup.hidden = false;
      setVal('pred-ha-url', config.haUrl ?? '');
      setVal('pred-ha-token', config.haToken ?? '');
    }
  }

  /* Removed obsolete fields */
  setVal('pred-sensors', config.sensors ? JSON.stringify(config.sensors, null, 2) : '');
  setVal('pred-derived', config.derived ? JSON.stringify(config.derived, null, 2) : '');

  // Populate sensor dropdown
  const sensorSelect = document.getElementById('pred-active-sensor');
  if (sensorSelect) {
    sensorSelect.innerHTML = '<option value="" disabled selected>Select a sensor…</option>';

    const addOption = (s) => {
      const opt = document.createElement('option');
      opt.textContent = s.name || s.id;
      opt.value = opt.textContent;
      sensorSelect.appendChild(opt);
    };

    if (config.sensors) config.sensors.forEach(addOption);
    if (config.derived) config.derived.forEach(addOption);
  }

  renderActiveConfig(config.activeConfig ?? null);
}

// ---------------------------------------------------------------------------
// Wire form inputs
// ---------------------------------------------------------------------------

function wireForm() {
  const debouncedSave = debounce(saveFormToServer, 600);

  /* Removed obsolete logic */
  for (const el of document.querySelectorAll('[data-predictions-only="true"]')) {
    el.addEventListener('input', debouncedSave);
    el.addEventListener('change', debouncedSave);
  }

  const runBtn = document.getElementById('pred-run-validation');
  if (runBtn) {
    runBtn.addEventListener('click', onRunValidation);
  }

  const recomputeBtn = document.getElementById('pred-recompute');
  if (recomputeBtn) {
    recomputeBtn.addEventListener('click', onRecompute);
  }

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

  return {
    haUrl: getVal('pred-ha-url'),
    haToken: getVal('pred-ha-token'),
    ...(sensors !== null ? { sensors } : {}),
    ...(derived !== null ? { derived } : {}),
    ...(activeConfig ? { activeConfig } : {}),
  };
}

// ---------------------------------------------------------------------------
// Recompute & Forecast
// ---------------------------------------------------------------------------

async function onRecompute() {
  updateSummaryStatus('Saving & Fetching...');

  try {
    // 1. Save Config
    const partial = readFormValues();
    await savePredictionConfig(partial);

    // 2. Fetch Forecast
    updateSummaryStatus('Running forecast...');
    const result = await fetchForecast();

    // 3. Render Chart
    renderForecastChart(result); // { forecast: [], recent: [] }
    renderHistoryChart(result.recent);


    // 4. Update Summary
    const values = result.forecast.values || [];
    const peak = values.length ? Math.max(...values) : 0;
    const min = values.length ? Math.min(...values) : 0;
    const totalWh = values.reduce((a, b) => a + b, 0) * 0.25; // 15min slots
    const totalKwh = totalWh / 1000;

    // Calculate Avg Error (MAE) from recent data
    let avgErrorW = 0;
    if (result.recent && result.recent.length > 0) {
      const validEntries = result.recent.filter(r => r.actual != null && r.predicted != null);
      if (validEntries.length > 0) {
        const sumError = validEntries.reduce((acc, r) => acc + Math.abs(r.actual - r.predicted), 0);
        avgErrorW = sumError / validEntries.length;
      }
    }

    updateSummaryMetrics(totalKwh, peak, min, avgErrorW);
    updateSummaryStatus('Predictions updated.', false);
  } catch (err) {
    console.error(err);
    updateSummaryStatus('Error: ' + err.message, true);
  }
}

function updateSummaryStatus(msg, isError = false) {
  const el = document.getElementById('summary-status');
  if (!el) return;
  el.textContent = msg;
  el.className = isError
    ? 'text-sm font-medium text-red-600 dark:text-red-400'
    : 'text-sm font-medium text-emerald-600 dark:text-emerald-400';
}

function updateSummaryMetrics(kwh, peakW, minW, avgErrorW) {
  const loadEl = document.getElementById('summary-total');
  const peakEl = document.getElementById('summary-peak');
  const minEl = document.getElementById('summary-min');
  const errorEl = document.getElementById('summary-error');

  if (loadEl) loadEl.textContent = kwh.toFixed(1);
  if (peakEl) peakEl.textContent = Math.round(peakW).toLocaleString();
  if (minEl && minW !== undefined) minEl.textContent = Math.round(minW).toLocaleString();
  if (errorEl && avgErrorW !== undefined) errorEl.textContent = Math.round(avgErrorW).toLocaleString();
}

function renderForecastChart({ forecast }) {
  const canvas = document.getElementById('pred-forecast-chart');
  if (!canvas) return;

  // Clean up legacy chart instance if it exists
  // Clean up legacy chart instance if it exists
  // renderChart handles this via canvas._chart

  // Aggregate 15-min slots into hourly kWh buckets for display
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

    // Watts * hours = Wh. 15min = 0.25 hours.
    const wh = values[i] * (stepMs / 3600000);
    hourMap.set(hourKey, hourMap.get(hourKey) + wh);
  }

  const sortedKeys = [...hourMap.keys()].sort((a, b) => a - b);
  const hourlyKwh = sortedKeys.map(k => hourMap.get(k) / 1000); // Wh -> kWh
  const axis = buildTimeAxisFromTimestamps(sortedKeys);

  const dim = (rgb) => {
    const m = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(rgb);
    return m ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, 0.6)` : rgb;
  };
  const stripe = (c) => window.pattern?.draw('diagonal', c) || c;

  renderChart(canvas, {
    type: 'bar',
    data: {
      labels: axis.labels,
      datasets: [
        {
          label: 'Consumption Forecast',
          data: hourlyKwh,
          backgroundColor: stripe(SOLUTION_COLORS.g2l),
          borderColor: SOLUTION_COLORS.g2l,
          borderWidth: 1,
          hoverBackgroundColor: stripe(dim(SOLUTION_COLORS.g2l)),
        }
      ]
    },
    options: getBaseOptions({ ...axis, yTitle: 'kWh' })
  });
}

function renderHistoryChart(recentData) {
  const canvas = document.getElementById('pred-history-chart');
  if (!canvas) return;

  // renderChart handles cleanup via canvas._chart

  if (!recentData || recentData.length === 0) return;

  // recentData is array of { date, time, hour, actual, predicted }
  // sort by time just in case
  const sorted = [...recentData].sort((a, b) => a.time - b.time);

  const timestamps = sorted.map(d => d.time);
  const axis = buildTimeAxisFromTimestamps(timestamps);

  const actuals = sorted.map(d => d.actual / 1000); // W -> kW/kWh
  const predicteds = sorted.map(d => d.predicted / 1000); // W -> kW/kWh

  renderChart(canvas, {
    type: 'line',
    data: {
      labels: axis.labels,
      datasets: [
        {
          label: 'Prediction',
          data: predicteds,
          borderColor: SOLUTION_COLORS.g2l, // Red/Consumption style
          backgroundColor: SOLUTION_COLORS.g2l,
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3
        },
        {
          label: 'Actual',
          data: actuals,
          borderColor: SOLUTION_COLORS.g2b, // Purple/Grid-to-Battery style (unused in this context)
          backgroundColor: SOLUTION_COLORS.g2b,
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3
        }
      ]
    },
    options: getBaseOptions({ ...axis, yTitle: 'kWh' }),
  });
}


// ---------------------------------------------------------------------------
// Run validation
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

    setStatus('Saving config…');

    try {
      // Save latest form values first
      const partial = readFormValues();
      await savePredictionConfig(partial);
    } catch (err) {
      setStatus(`Save failed: ${err.message}`, true);
      return;
    }

    setStatus('Fetching HA data and running validation…');
    if (resultsEl) resultsEl.hidden = true;
    const noResultsEl = document.getElementById('pred-no-results');
    if (noResultsEl) noResultsEl.hidden = true;

    try {
      const result = await runValidation();
      validationResults = result;
      renderResults(result);
      setStatus(`Validation complete. ${result.results.length} combinations evaluated.`);
    } catch (err) {
      setStatus(`Error: ${err.message}`, true);
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
// Render results
// ---------------------------------------------------------------------------

function renderResults({ sensorNames, results }) {
  const resultsEl = document.getElementById('pred-results');
  if (!resultsEl) return;

  resultsEl.hidden = false;

  const noResultsEl = document.getElementById('pred-no-results');
  if (noResultsEl) noResultsEl.hidden = true;

  // Sensor tabs
  renderSensorTabs(sensorNames);

  // Default to first sensor
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

    // Active state
    btn.classList.toggle('bg-sky-600', isActive);
    btn.classList.toggle('text-white', isActive);
    btn.classList.toggle('border-sky-600', isActive);
    btn.classList.toggle('hover:bg-sky-700', isActive);

    // Inactive state
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
    // Update inputs first to reflect the choice
    renderActiveConfig(activeConfig);

    // Then save (which will read from the inputs)
    const partial = readFormValues();
    await savePredictionConfig(partial);

    setStatus(`Active config updated: ${row.sensor} / ${row.lookbackWeeks}w / ${row.dayFilter} / ${row.aggregation}`);
  } catch (err) {
    setStatus(`Failed to save active config: ${err.message}`, true);
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
  const actualData = preds.map(p => p.actual);
  const predictedData = preds.map(p => p.predicted);

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
          data: actualData,
          borderColor: 'rgb(14, 165, 233)',
          backgroundColor: 'rgba(14, 165, 233, 0.1)',
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
        },
        {
          label: 'Predicted (Wh)',
          data: predictedData,
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
      scales: {
        y: { title: { display: true, text: 'Wh' } },
      },
    },
  });

  const title = document.getElementById('pred-chart-title');
  if (title) {
    title.textContent = `Accuracy: ${row.sensor} / ${row.lookbackWeeks}w / ${row.dayFilter} / ${row.aggregation}`;
  }
}

// ---------------------------------------------------------------------------
// Active config display
// ---------------------------------------------------------------------------

function renderActiveConfig(activeConfig) {
  if (!activeConfig) return;

  setVal('pred-active-sensor', activeConfig.sensor ?? '');
  setVal('pred-active-lookback', activeConfig.lookbackWeeks ?? '');
  setVal('pred-active-filter', activeConfig.dayFilter ?? '');
  setVal('pred-active-agg', activeConfig.aggregation ?? '');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setStatus(msg, isError = false) {
  const el = document.getElementById('pred-status');
  if (!el) return;
  el.textContent = msg;
  el.className = isError
    ? 'text-sm text-red-600 dark:text-red-400'
    : 'text-sm text-ink-soft dark:text-slate-400';
}

function setVal(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

function getVal(id) {
  return document.getElementById(id)?.value ?? '';
}

function parseSilently(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}
