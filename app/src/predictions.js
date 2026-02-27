/* global Chart */
/**
 * predictions.js
 *
 * Self-contained browser module for the Predictions tab.
 */

import {
  fetchPredictionConfig,
  savePredictionConfig,
  runPvForecast,
  runCombinedForecast,
} from './api/api.js';
import { debounce } from './utils.js';
import { buildTimeAxisFromTimestamps, getBaseOptions, renderChart, toRGBA, SOLUTION_COLORS } from './charts.js';
import { initValidation } from './predictions-validation.js';

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

  initValidation({ readFormValues, renderLoadConfig, setComparisonStatus });

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
  updateStatus('load', 'Running load forecast…');
  updateStatus('pv', 'Running PV forecast…');

  try {
    const partial = readFormValues();
    await savePredictionConfig(partial);

    const result = await runCombinedForecast();

    updateForecastUI('load', result.load);
    updateForecastUI('pv', result.pv);
  } catch (err) {
    console.error(err);
    updateStatus('load', 'Error: ' + err.message, true);
    updateStatus('pv', 'Error: ' + err.message, true);
  }
}

// ---------------------------------------------------------------------------
// PV-only forecast ("Forecast PV" button)
// ---------------------------------------------------------------------------

async function onPvForecast() {
  updateStatus('pv', 'Running PV forecast…');

  try {
    const partial = readFormValues();
    await savePredictionConfig(partial);

    const result = await runPvForecast();

    updateForecastUI('pv', result);
  } catch (err) {
    console.error(err);
    updateStatus('pv', 'Error: ' + err.message, true);
  }
}

// ---------------------------------------------------------------------------
// Shared Status & Metrics Renderers
// ---------------------------------------------------------------------------

function updateForecastUI(type, result) {
  const label = type === 'load' ? 'Load' : 'PV';
  if (result) {
    renderForecastChart(type, result);
    if (type === 'load') {
      renderLoadAccuracyChart(result.recent);
    } else {
      renderPvAccuracyChart(result.recent);
    }
    updateMetrics(type, result);
    updateStatus(type, `${label} forecast updated`);
  } else {
    updateStatus(type, `${label} forecast skipped`);
  }
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

  // Calculate load specific metrics if we are dealing with load data
  let min = 0;
  if (prefix === 'load') {
    min = values.length ? Math.min(...values) : 0;
  }

  const totalKwh = values.reduce((a, b) => a + b, 0) * 0.25 / 1000;

  let avgErrorW = 0;
  if (prefix === 'load') {
    const recent = resultObject.recent || [];
    const valid = recent.filter(r => r.actual != null && r.predicted != null);
    if (valid.length > 0) {
      avgErrorW = valid.reduce((acc, r) => acc + Math.abs(r.actual - r.predicted), 0) / valid.length;
    }
  } else if (prefix === 'pv') {
    avgErrorW = resultObject.metrics?.mae ?? 0;
  }

  setEl(`${prefix}-summary-total`, totalKwh.toFixed(1));
  setEl(`${prefix}-summary-peak`, Math.round(peak).toLocaleString());
  setEl(`${prefix}-summary-error`, Math.round(avgErrorW).toLocaleString());
  if (prefix === 'load') {
    setEl(`${prefix}-summary-min`, Math.round(min).toLocaleString());
  }
}

function renderForecastChart(type, result) {
  const isLoad = type === 'load';
  const canvas = document.getElementById(`${type}-forecast-chart`);
  if (!canvas || !result?.forecast) return;

  const { timestamps, hourlyKwh } = aggregateHourlyKwh(result.forecast);
  const axis = buildTimeAxisFromTimestamps(timestamps);
  const color = isLoad ? SOLUTION_COLORS.g2l : SOLUTION_COLORS.pv2g;

  renderChart(canvas, {
    type: 'bar',
    data: {
      labels: axis.labels,
      datasets: [{
        label: isLoad ? 'Load Forecast' : 'PV Forecast',
        data: hourlyKwh,
        backgroundColor: stripe(color),
        borderColor: color,
        borderWidth: 1,
        hoverBackgroundColor: stripe(toRGBA(color, 0.6)),
      }]
    },
    options: getBaseOptions({ ...axis, yTitle: 'kWh' })
  });
}

function renderLoadAccuracyChart(recentData) {
  renderAccuracyChart(
    'load-accuracy-chart',
    recentData,
    {
      actualLabel: 'Actual',
      predLabel: 'Prediction',
      actualColor: SOLUTION_COLORS.b2l,
      predColor: SOLUTION_COLORS.g2l,
      valueActual: d => d.actual,
      valuePred: d => d.predicted,
    }
  );
}

// ---------------------------------------------------------------------------
// PV: status, metrics, charts
// ---------------------------------------------------------------------------



function renderPvAccuracyChart(recentData) {
  renderAccuracyChart(
    'pv-accuracy-chart',
    recentData,
    {
      actualLabel: 'Actual',
      predLabel: 'Predicted',
      actualColor: SOLUTION_COLORS.pv2b,
      predColor: SOLUTION_COLORS.pv2g,
      valueActual: d => d.actual ?? 0,
      valuePred: d => d.predicted ?? 0,
    }
  );
}

function renderAccuracyChart(canvasId, recentData, options) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !recentData || recentData.length === 0) return;

  const sorted = [...recentData].sort((a, b) => a.time - b.time);
  const axis = buildTimeAxisFromTimestamps(sorted.map(d => d.time));

  renderChart(canvas, {
    type: 'line',
    data: {
      labels: axis.labels,
      datasets: [
        {
          label: options.actualLabel,
          data: sorted.map(d => options.valueActual(d) / 1000),
          borderColor: 'transparent',
          backgroundColor: toRGBA(options.actualColor, 0.25),
          borderWidth: 0,
          pointRadius: 0,
          tension: 0.3,
          fill: true,
        },
        {
          label: options.predLabel,
          data: sorted.map(d => options.valuePred(d) / 1000),
          borderColor: options.predColor,
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
