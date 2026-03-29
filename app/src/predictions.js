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
import { createTooltipHandler, fmtKwh, getChartAnimations, ttHeader, ttRow, ttDivider } from './chart-tooltip.js';
import { initValidation } from './predictions-validation.js';

let lastLoadForecast = null;
let lastPvForecast = null;

export async function initPredictionsTab() {
  await hydrateForm();
  wireForm();
  onForecastAll();
}

// ---------------------------------------------------------------------------
// Chart helpers
// ---------------------------------------------------------------------------

const stripe = (c) => window.pattern?.draw('diagonal', c) || c;

/** Aggregate a ForecastSeries into { timestamps[], values[] } with the given stepMinutes. */
function aggregateForecastKwh(forecast, stepMinutes = 60) {
  const timeMap = new Map();
  const values = forecast.values || [];
  const startTs = new Date(forecast.start).getTime();
  const inputStepMs = (forecast.step || 15) * 60 * 1000;
  const targetStepMs = stepMinutes * 60 * 1000;

  for (let i = 0; i < values.length; i++) {
    const ts = startTs + i * inputStepMs;
    const bucketTs = Math.floor(ts / targetStepMs) * targetStepMs;
    if (!timeMap.has(bucketTs)) timeMap.set(bucketTs, 0);
    timeMap.set(bucketTs, timeMap.get(bucketTs) + values[i] * (inputStepMs / 3600000));
  }

  const timestamps = [...timeMap.keys()].sort((a, b) => a - b);
  const aggregatedKwh = timestamps.map(k => timeMap.get(k) / 1000);
  return { timestamps, values: aggregatedKwh };
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
  document.getElementById('forecast-chart-15m')
    ?.addEventListener('change', renderCombinedForecastChart);

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
    pvMode: getVal('pred-pv-mode') || 'hourly',
  };

  return {
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
    if (type === 'load') {
      lastLoadForecast = result.forecast ?? null;
      renderLoadAccuracyChart(result.recent);
    } else {
      lastPvForecast = result.forecast ?? null;
      renderPvAccuracyChart(result.recent);
    }
    renderCombinedForecastChart();
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

  const avgErrorW = resultObject.metrics?.mae ?? 0;

  setEl(`${prefix}-summary-total`, totalKwh.toFixed(1));
  setEl(`${prefix}-summary-peak`, Math.round(peak).toLocaleString());
  setEl(`${prefix}-summary-error`, Math.round(avgErrorW).toLocaleString());
  if (prefix === 'load') {
    setEl(`${prefix}-summary-min`, Math.round(min).toLocaleString());
  }
}

function renderCombinedForecastChart() {
  const canvas = document.getElementById('forecast-chart');
  if (!canvas) return;

  const is15m = document.getElementById('forecast-chart-15m')?.checked;
  const stepMinutes = is15m ? 15 : 60;

  const loadAgg = lastLoadForecast ? aggregateForecastKwh(lastLoadForecast, stepMinutes) : { timestamps: [], values: [] };
  const pvAgg = lastPvForecast ? aggregateForecastKwh(lastPvForecast, stepMinutes) : { timestamps: [], values: [] };

  const allTs = [...new Set([...loadAgg.timestamps, ...pvAgg.timestamps])].sort((a, b) => a - b);
  const axis = buildTimeAxisFromTimestamps(allTs);

  const loadMap = new Map(loadAgg.timestamps.map((t, i) => [t, loadAgg.values[i]]));
  const pvMap = new Map(pvAgg.timestamps.map((t, i) => [t, pvAgg.values[i]]));

  renderChart(canvas, {
    type: 'bar',
    data: {
      labels: axis.labels,
      datasets: [
        {
          label: 'Load',
          data: allTs.map(t => loadMap.get(t) ?? null),
          backgroundColor: stripe(SOLUTION_COLORS.g2l),
          borderColor: SOLUTION_COLORS.g2l,
          borderWidth: 1,
          hoverBackgroundColor: stripe(toRGBA(SOLUTION_COLORS.g2l, 0.6)),
        },
        {
          label: 'Solar',
          data: allTs.map(t => pvMap.get(t) ?? null),
          backgroundColor: stripe(SOLUTION_COLORS.pv2g),
          borderColor: SOLUTION_COLORS.pv2g,
          borderWidth: 1,
          hoverBackgroundColor: stripe(toRGBA(SOLUTION_COLORS.pv2g, 0.6)),
        },
      ],
    },
    options: getBaseOptions({ ...axis, yTitle: 'kWh' }, {
      ...getChartAnimations('bar', allTs.length),
      plugins: {
        tooltip: {
          mode: 'index',
          intersect: false,
          enabled: false,
          external: createTooltipHandler({
            renderContent: (_idx, tooltip) => {
              const time = tooltip.title?.[0] ?? '';
              let html = ttHeader(time);
              for (const pt of (tooltip.dataPoints ?? [])) {
                if (pt.raw == null) continue;
                html += ttRow(pt.dataset.borderColor, pt.dataset.label, `${fmtKwh(pt.raw)} kWh`);
              }
              return html;
            },
          }),
          callbacks: { title: axis.tooltipTitleCb },
        },
      },
    }),
  });
}

function renderLoadAccuracyChart(recentData) {
  renderAccuracyCharts(
    'load-accuracy-chart',
    'load-accuracy-diff-chart',
    'load-daily-net-error',
    recentData,
    {
      actualLabel: 'Actual',
      predLabel: 'Prediction',
      actualColor: 'rgb(14, 165, 233)',
      predColor: 'rgb(249, 115, 22)',
      valueActual: d => d.actual,
      valuePred: d => d.predicted,
    }
  );
}

// ---------------------------------------------------------------------------
// PV: status, metrics, charts
// ---------------------------------------------------------------------------



function renderPvAccuracyChart(recentData) {
  renderAccuracyCharts(
    'pv-accuracy-chart',
    'pv-accuracy-diff-chart',
    'pv-daily-net-error',
    recentData,
    {
      actualLabel: 'Actual',
      predLabel: 'Predicted',
      actualColor: 'rgb(14, 165, 233)',
      predColor: 'rgb(249, 115, 22)',
      valueActual: d => d.actual ?? 0,
      valuePred: d => d.predicted ?? 0,
    }
  );
}

function buildDayDividersPlugin(timestamps, dayNetW, netErrorContainerId) {
  const daySpans = new Map();
  for (let i = 0; i < timestamps.length; i++) {
    const dateStr = new Date(timestamps[i]).toLocaleDateString('en-CA');
    if (!daySpans.has(dateStr)) daySpans.set(dateStr, { first: i, last: i });
    else daySpans.get(dateStr).last = i;
  }
  const days = [...daySpans.entries()];
  let lastChartLeft = null; // skip HTML rebuild when chartArea hasn't changed (e.g. animation frames)

  return {
    id: 'dayDividers',
    afterDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!scales.x || !chartArea) return;

      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(148,163,184,0.3)';
      ctx.lineWidth = 1;
      ctx.font = '9px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(148,163,184,0.5)';
      ctx.textAlign = 'center';

      for (let i = 0; i < days.length; i++) {
        const [_dateStr, { first, last }] = days[i];
        if (i > 0) {
          const x = scales.x.getPixelForValue(first);
          ctx.beginPath();
          ctx.moveTo(x, chartArea.top);
          ctx.lineTo(x, chartArea.bottom);
          ctx.stroke();
        }
        const midX = (scales.x.getPixelForValue(first) + scales.x.getPixelForValue(last)) / 2;
        const dayName = new Date(timestamps[first]).toLocaleDateString('en-US', { weekday: 'short' });
        ctx.fillText(dayName, midX, chartArea.top + 10);
      }

      ctx.restore();

      if (!netErrorContainerId || !dayNetW || chartArea.left === lastChartLeft) return;
      lastChartLeft = chartArea.left;

      const container = document.getElementById(netErrorContainerId);
      if (!container) return;

      let html = `<div style="position:absolute;top:2px;left:${chartArea.left}px;font-size:9px;font-weight:600;letter-spacing:0.08em;color:rgba(148,163,184,0.45);text-transform:uppercase;">net error (kWh)</div>`;

      for (const [dateStr, { first, last }] of days) {
        const midX = (scales.x.getPixelForValue(first) + scales.x.getPixelForValue(last)) / 2;
        const netKwh = (dayNetW.get(dateStr) ?? 0) / 1000;
        const color = netKwh >= 0 ? 'rgb(139,201,100)' : 'rgb(233,122,131)';
        const sign = netKwh >= 0 ? '+' : '−';
        html += `<div style="position:absolute;top:16px;left:${midX}px;transform:translateX(-50%);font-size:11px;font-weight:600;color:${color};white-space:nowrap">${sign}${fmtKwh(Math.abs(netKwh))}</div>`;
      }

      container.style.position = 'relative';
      container.style.height = '32px';
      container.innerHTML = html;
      container.classList.remove('hidden');
    },
  };
}

function renderAccuracyCharts(overlayCanvasId, diffCanvasId, netErrorContainerId, recentData, options) {
  const overlayCanvas = document.getElementById(overlayCanvasId);
  const diffCanvas = document.getElementById(diffCanvasId);
  if (!overlayCanvas || !recentData || recentData.length === 0) return;

  const sorted = [...recentData].sort((a, b) => a.time - b.time);
  const axis = buildTimeAxisFromTimestamps(sorted.map(d => d.time));

  const timestamps = sorted.map(d => d.time);

  const dayNetW = new Map();
  for (const d of sorted) {
    const dateStr = new Date(d.time).toLocaleDateString('en-CA');
    const diff = options.valuePred(d) - options.valueActual(d);
    dayNetW.set(dateStr, (dayNetW.get(dateStr) ?? 0) + diff);
  }

  const dayDividersPlugin = buildDayDividersPlugin(timestamps, dayNetW, netErrorContainerId);
  const dayDividersPluginDiff = buildDayDividersPlugin(timestamps, null, null);

  // Chart 1: two clean lines, solid legend swatch (backgroundColor = line color, fill: false)
  renderChart(overlayCanvas, {
    type: 'line',
    data: {
      labels: axis.labels,
      datasets: [
        {
          label: options.actualLabel,
          data: sorted.map(d => options.valueActual(d) / 1000),
          borderColor: options.actualColor,
          backgroundColor: options.actualColor,
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
          fill: false,
        },
        {
          label: options.predLabel,
          data: sorted.map(d => options.valuePred(d) / 1000),
          borderColor: options.predColor,
          backgroundColor: options.predColor,
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
          fill: false,
        },
      ],
    },
    options: getBaseOptions({ ...axis, yTitle: 'kWh' }, {
      ...getChartAnimations('line', sorted.length),
      plugins: {
        tooltip: {
          mode: 'index',
          intersect: false,
          enabled: false,
          external: createTooltipHandler({
            renderContent: (_idx, tooltip) => {
              const time = tooltip.title?.[0] ?? '';
              let html = ttHeader(time);
              for (const pt of (tooltip.dataPoints ?? [])) {
                html += ttRow(pt.dataset.borderColor, pt.dataset.label, `${fmtKwh(pt.raw)} kWh`);
              }
              return html;
            },
          }),
          callbacks: { title: axis.tooltipTitleCb },
        },
      },
    }),
    plugins: [dayDividersPlugin],
  });

  // Chart 2: predicted − actual difference area, no legend
  if (!diffCanvas) return;
  renderChart(diffCanvas, {
    type: 'line',
    data: {
      labels: axis.labels,
      datasets: [
        {
          label: 'Difference (pred − actual)',
          data: sorted.map(d => (options.valuePred(d) - options.valueActual(d)) / 1000),
          borderColor: 'rgba(100,116,139,0.6)',
          backgroundColor: 'transparent',
          borderWidth: 1,
          pointRadius: 0,
          tension: 0.3,
          fill: { target: 'origin', above: 'rgba(139,201,100,0.45)', below: 'rgba(233,122,131,0.45)' },
        },
      ],
    },
    options: getBaseOptions({ ...axis, yTitle: 'kWh diff' }, {
      ...getChartAnimations('line', sorted.length),
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
          enabled: false,
          external: createTooltipHandler({
            renderContent: (_idx, tooltip) => {
              const time = tooltip.title?.[0] ?? '';
              const pt = tooltip.dataPoints?.[0];
              if (!pt) return ttHeader(time);
              const v = pt.raw;
              const color = v >= 0 ? 'rgb(139,201,100)' : 'rgb(233,122,131)';
              let html = ttHeader(time);
              html += ttDivider();
              html += ttRow(color, 'Pred − Actual', `${v >= 0 ? '+' : ''}${fmtKwh(Math.abs(v))} kWh`);
              return html;
            },
          }),
          callbacks: { title: axis.tooltipTitleCb },
        },
      },
    }),
    plugins: [dayDividersPluginDiff],
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
  // @deprecated: migrate old forecastResolution to pvMode
  const pvMode = pvConfig.pvMode ?? (pvConfig.forecastResolution === 15 ? 'hybrid' : 'hourly');
  setVal('pred-pv-mode', pvMode);
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
