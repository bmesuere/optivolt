/**
 * predictions.js
 *
 * Self-contained browser module for the Predictions tab.
 */

import {
  createPredictionAdjustment,
  deletePredictionAdjustment,
  fetchPredictionAdjustments,
  fetchPredictionConfig,
  fetchStoredData,
  savePredictionConfig,
  updatePredictionAdjustment,
  runPvForecast,
  runCombinedForecast,
} from './api/api.js';
import { debounce, escapeHtml } from './utils.js';
import { buildTimeAxisFromTimestamps, getBaseOptions, renderChart, toRGBA, SOLUTION_COLORS } from './charts.js';
import { createTooltipHandler, fmtKwh, getChartAnimations, ttHeader, ttRow, ttDivider } from './chart-tooltip.js';
import { initValidation } from './predictions-validation.js';

let lastLoadForecast = null;
let lastPvForecast = null;
let lastLoadForecastRaw = null;
let lastPvForecastRaw = null;
let predictionAdjustments = [];
let forecastChartSelection = null;
let forecastChartDrag = null;
let adjustmentDraft = null;

export async function initPredictionsTab() {
  await hydrateForm();
  await loadAdjustments();
  await hydrateForecastsFromStoredData();
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

export function applyAdjustmentsToForecastSeries(forecast, adjustments, series) {
  if (!forecast || !Array.isArray(forecast.values)) return forecast;
  const nowMs = Date.now();
  const relevant = (adjustments || []).filter(adj => adj.series === series && new Date(adj.end).getTime() > nowMs);
  if (!relevant.length) return forecast;

  const startTs = new Date(forecast.start).getTime();
  const stepMs = (forecast.step || 15) * 60 * 1000;
  return {
    ...forecast,
    values: forecast.values.map((raw, index) => {
      const slotTs = startTs + index * stepMs;
      const matching = relevant.filter(adj => slotTs >= new Date(adj.start).getTime() && slotTs < new Date(adj.end).getTime());
      if (!matching.length) return raw;

      const setAdjustment = matching
        .filter(adj => adj.mode === 'set')
        .reduce((best, adj) => !best || adj.updatedAt > best.updatedAt ? adj : best, null);
      const base = setAdjustment ? Number(setAdjustment.value_W) : raw;
      const delta = matching
        .filter(adj => adj.mode === 'add')
        .reduce((sum, adj) => sum + Number(adj.value_W || 0), 0);
      return Math.max(0, base + delta);
    }),
  };
}

export function buildForecastSelectionRange(startIndex, endIndex, timestamps, stepMinutes) {
  if (!timestamps.length) return null;
  const low = Math.min(startIndex, endIndex);
  const high = Math.max(startIndex, endIndex);
  const first = Math.max(0, Math.min(timestamps.length - 1, low));
  const last = Math.max(0, Math.min(timestamps.length - 1, high));
  const stepMs = stepMinutes * 60 * 1000;
  return {
    startIndex: first,
    endIndex: last,
    start: new Date(timestamps[first]).toISOString(),
    end: new Date(timestamps[last] + stepMs).toISOString(),
  };
}

export function forecastSeriesFromCategoryX(x, bounds) {
  if (!bounds || !Number.isFinite(x)) return 'load';
  const mid = (bounds.left + bounds.right) / 2;
  return x >= mid ? 'pv' : 'load';
}

export function futureForecastSeries(series, nowMs = Date.now()) {
  if (!series || !Array.isArray(series.values) || !series.values.length) return null;
  const startMs = new Date(series.start).getTime();
  if (!Number.isFinite(startMs)) return null;
  const step = Number(series.step || 15);
  if (!Number.isFinite(step) || step <= 0) return null;

  const stepMs = step * 60 * 1000;
  const offset = Math.max(0, Math.floor((nowMs - startMs) / stepMs));
  if (offset >= series.values.length) return null;
  return {
    ...series,
    start: new Date(startMs + offset * stepMs).toISOString(),
    step,
    values: series.values.slice(offset),
  };
}

function refreshAdjustedForecastsFromRaw() {
  lastLoadForecast = lastLoadForecastRaw
    ? applyAdjustmentsToForecastSeries(lastLoadForecastRaw, predictionAdjustments, 'load')
    : null;
  lastPvForecast = lastPvForecastRaw
    ? applyAdjustmentsToForecastSeries(lastPvForecastRaw, predictionAdjustments, 'pv')
    : null;
}

async function loadAdjustments() {
  try {
    const result = await fetchPredictionAdjustments();
    predictionAdjustments = Array.isArray(result?.adjustments) ? result.adjustments : [];
    renderAdjustmentList();
  } catch (err) {
    console.error('Failed to load prediction adjustments:', err);
  }
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
    renderCombinedForecastChart();
    if (load) updateStoredForecastMetrics('load', load, lastLoadForecast);
    if (pv) updateStoredForecastMetrics('pv', pv, lastPvForecast);
  } catch (err) {
    console.error('Failed to load stored forecast data:', err);
  }
}

function setAdjustments(nextAdjustments) {
  predictionAdjustments = Array.isArray(nextAdjustments) ? nextAdjustments : [];
  refreshAdjustedForecastsFromRaw();
  renderCombinedForecastChart();
  renderAdjustmentList();
}

function formatAdjustmentTime(value) {
  return new Date(value).toLocaleString([], {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatRange(start, end) {
  return `${formatAdjustmentTime(start)} – ${formatAdjustmentTime(end)}`;
}

function toDatetimeLocalValue(value) {
  const d = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromDatetimeLocalValue(value) {
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? new Date(ts).toISOString() : '';
}

function adjustmentSummary(adj) {
  const modeText = adj.mode === 'set' ? 'set to' : 'add';
  const sign = adj.mode === 'add' && adj.value_W > 0 ? '+' : '';
  return `${adj.series === 'pv' ? 'PV' : 'Load'} ${modeText} ${sign}${Math.round(adj.value_W).toLocaleString()} W`;
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

  setVal('pred-active-type', config.activeType ?? 'historical');
  setVal('pred-fixed-load-w', config.fixedPredictor?.load_W ?? '');
  renderHistoricalConfig(config.historicalPredictor ?? null);
  renderPvConfig(config.pvConfig ?? null);
  updatePredictorFieldVisibility();
}

function updatePredictorFieldVisibility() {
  const type = getVal('pred-active-type') || 'historical';
  const isFixed = type === 'fixed';
  document.getElementById('pred-fixed-fields')?.classList.toggle('hidden', !isFixed);
  document.getElementById('pred-historical-fields')?.classList.toggle('hidden', isFixed);
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

  document.getElementById('pred-active-type')
    ?.addEventListener('change', updatePredictorFieldVisibility);

  initValidation({ readFormValues, renderHistoricalConfig, setComparisonStatus });

  document.getElementById('pred-load-forecast')
    ?.addEventListener('click', onForecastAll);
  document.getElementById('pred-pv-forecast')
    ?.addEventListener('click', onPvForecast);
  document.getElementById('forecast-chart-15m')
    ?.addEventListener('change', renderCombinedForecastChart);

  wireAdjustmentPopover();

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

  const activeType = getVal('pred-active-type') || 'historical';

  const activeSensor = getVal('pred-active-sensor');
  const activeLookback = getVal('pred-active-lookback');

  const historicalPredictor = activeSensor ? {
    sensor: activeSensor,
    lookbackWeeks: activeLookback ? parseInt(activeLookback, 10) : 4,
    dayFilter: getVal('pred-active-filter') || 'same',
    aggregation: getVal('pred-active-agg') || 'mean',
  } : null;

  const fixedLoadW = getVal('pred-fixed-load-w');
  const fixedLoadWParsed = fixedLoadW !== '' ? parseFloat(fixedLoadW) : NaN;
  const fixedPredictor = Number.isFinite(fixedLoadWParsed) && fixedLoadWParsed >= 0 ? { load_W: fixedLoadWParsed } : null;

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
    activeType,
    ...(historicalPredictor ? { historicalPredictor } : {}),
    ...(fixedPredictor ? { fixedPredictor } : {}),
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
      lastLoadForecastRaw = result.rawForecast ?? result.forecast ?? null;
      lastLoadForecast = result.forecast ?? null;
      renderLoadAccuracyChart(result.recent);
    } else {
      lastPvForecastRaw = result.rawForecast ?? result.forecast ?? null;
      lastPvForecast = result.forecast ?? null;
      renderPvAccuracyChart(result.recent);
    }
    refreshAdjustedForecastsFromRaw();
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

function updateStoredForecastMetrics(prefix, rawForecast, adjustedForecast) {
  updateMetrics(prefix, { forecast: adjustedForecast ?? rawForecast, metrics: { mae: NaN } });
  setEl(`${prefix}-summary-error`, '--');
  updateStatus(prefix, 'Stored data loaded');
}

function adjustmentOverlapsBucket(adj, bucketStartMs, bucketEndMs) {
  return new Date(adj.start).getTime() < bucketEndMs && new Date(adj.end).getTime() > bucketStartMs;
}

function findAdjustmentAtBucket(bucketStartMs, bucketEndMs, series = null) {
  return predictionAdjustments.findLast(adj => (!series || adj.series === series) && adjustmentOverlapsBucket(adj, bucketStartMs, bucketEndMs)) ?? null;
}

function findAdjustmentIndexes(adj, timestamps, stepMinutes) {
  const stepMs = stepMinutes * 60 * 1000;
  const adjEndMs = new Date(adj.end).getTime();
  const first = timestamps.findIndex(ts => adjustmentOverlapsBucket(adj, ts, ts + stepMs));
  if (first < 0) return null;
  let last = first;
  for (let i = first + 1; i < timestamps.length; i++) {
    if (timestamps[i] >= adjEndMs) break;
    if (adjustmentOverlapsBucket(adj, timestamps[i], timestamps[i] + stepMs)) last = i;
  }
  return { first, last };
}

function categoryBounds(chart, index) {
  const x = chart.scales.x;
  const labels = chart.data.labels || [];
  const center = x.getPixelForValue(index);
  const prev = index > 0 ? x.getPixelForValue(index - 1) : null;
  const next = index < labels.length - 1 ? x.getPixelForValue(index + 1) : null;
  const half = next != null
    ? Math.abs(next - center) / 2
    : prev != null
      ? Math.abs(center - prev) / 2
      : (chart.chartArea.right - chart.chartArea.left) / 2;
  return {
    left: Math.max(chart.chartArea.left, center - half),
    right: Math.min(chart.chartArea.right, center + half),
  };
}

function seriesLaneBounds(bounds, series) {
  const width = bounds.right - bounds.left;
  const gap = Math.min(2, width * 0.05);
  const mid = (bounds.left + bounds.right) / 2;
  if (series === 'pv') {
    return {
      left: Math.min(bounds.right, mid + gap),
      right: bounds.right,
    };
  }
  return {
    left: bounds.left,
    right: Math.max(bounds.left, mid - gap),
  };
}

function drawSeriesLane(chart, index, series, draw) {
  const bounds = seriesLaneBounds(categoryBounds(chart, index), series);
  const width = bounds.right - bounds.left;
  if (width <= 0) return;
  draw(bounds.left, width);
}

function makeAdjustmentOverlayPlugin(timestamps, stepMinutes) {
  return {
    id: 'predictionAdjustmentOverlay',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea } = chart;
      if (!chartArea || !timestamps.length) return;

      ctx.save();
      for (const adj of predictionAdjustments) {
        const range = findAdjustmentIndexes(adj, timestamps, stepMinutes);
        if (!range) continue;
        const color = adj.series === 'pv' ? SOLUTION_COLORS.pv2g : SOLUTION_COLORS.g2l;
        ctx.fillStyle = toRGBA(color, 0.10);
        for (let i = range.first; i <= range.last; i++) {
          drawSeriesLane(chart, i, adj.series, (left, width) => {
            ctx.fillRect(left, chartArea.top, width, chartArea.bottom - chartArea.top);
          });
        }
      }

      if (forecastChartSelection) {
        ctx.fillStyle = 'rgba(14, 165, 233, 0.10)';
        ctx.strokeStyle = 'rgba(14, 165, 233, 0.75)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
        for (let i = forecastChartSelection.startIndex; i <= forecastChartSelection.endIndex; i++) {
          drawSeriesLane(chart, i, forecastChartSelection.series, (left, width) => {
            ctx.fillRect(left, chartArea.top, width, chartArea.bottom - chartArea.top);
            ctx.strokeRect(left, chartArea.top + 1, width, chartArea.bottom - chartArea.top - 2);
          });
        }
      }
      ctx.restore();
    },
  };
}

function makeForecastOriginalMarkersPlugin(timestamps, rawSeriesMaps) {
  return {
    id: 'forecastOriginalMarkers',
    afterDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea || !timestamps.length || !scales.y) return;
      const isDark = document.documentElement.classList.contains('dark');
      const markerFill = isDark ? 'rgba(226, 232, 240, 0.96)' : 'rgba(71, 85, 105, 0.92)';
      const markerStroke = isDark ? 'rgba(15, 23, 42, 0.95)' : 'rgba(255, 255, 255, 0.95)';

      ctx.save();
      ctx.beginPath();
      ctx.rect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top);
      ctx.clip();

      for (let datasetIndex = 0; datasetIndex < chart.data.datasets.length; datasetIndex++) {
        const dataset = chart.data.datasets[datasetIndex];
        const rawMap = rawSeriesMaps[dataset.series];
        if (!rawMap) continue;

        const meta = chart.getDatasetMeta(datasetIndex);
        ctx.setLineDash([]);
        ctx.lineJoin = 'round';

        for (let i = 0; i < timestamps.length; i++) {
          const raw = rawMap.get(timestamps[i]);
          const adjusted = dataset.data[i];
          const bar = meta.data[i];
          if (raw == null || adjusted == null || !bar || Math.abs(raw - adjusted) <= 0.001) continue;

          const props = bar.getProps(['x', 'width'], true);
          const rawY = scales.y.getPixelForValue(raw);
          const markerSize = Math.max(3.5, Math.min(5, props.width * 0.22));
          ctx.beginPath();
          ctx.moveTo(props.x, rawY - markerSize);
          ctx.lineTo(props.x + markerSize, rawY);
          ctx.lineTo(props.x, rawY + markerSize);
          ctx.lineTo(props.x - markerSize, rawY);
          ctx.closePath();
          ctx.fillStyle = markerFill;
          ctx.strokeStyle = markerStroke;
          ctx.lineWidth = 2;
          ctx.fill();
          ctx.stroke();
        }
      }
      ctx.restore();
    },
  };
}

function makeForecastDataset(label, data, color, series) {
  return {
    label,
    data,
    series,
    backgroundColor: stripe(color),
    borderColor: color,
    borderWidth: 1,
    hoverBackgroundColor: stripe(toRGBA(color, 0.6)),
    barPercentage: 0.9,
    categoryPercentage: 0.8,
  };
}

function renderCombinedForecastChart() {
  const canvas = document.getElementById('forecast-chart');
  if (!canvas) return;

  const is15m = document.getElementById('forecast-chart-15m')?.checked;
  const stepMinutes = is15m ? 15 : 60;

  const loadAgg = lastLoadForecast ? aggregateForecastKwh(lastLoadForecast, stepMinutes) : { timestamps: [], values: [] };
  const pvAgg = lastPvForecast ? aggregateForecastKwh(lastPvForecast, stepMinutes) : { timestamps: [], values: [] };
  const rawLoadAgg = lastLoadForecastRaw ? aggregateForecastKwh(lastLoadForecastRaw, stepMinutes) : { timestamps: [], values: [] };
  const rawPvAgg = lastPvForecastRaw ? aggregateForecastKwh(lastPvForecastRaw, stepMinutes) : { timestamps: [], values: [] };

  const allTs = [...new Set([
    ...loadAgg.timestamps,
    ...pvAgg.timestamps,
    ...rawLoadAgg.timestamps,
    ...rawPvAgg.timestamps,
  ])].sort((a, b) => a - b);
  const axis = buildTimeAxisFromTimestamps(allTs);

  const loadMap = new Map(loadAgg.timestamps.map((t, i) => [t, loadAgg.values[i]]));
  const pvMap = new Map(pvAgg.timestamps.map((t, i) => [t, pvAgg.values[i]]));
  const rawLoadMap = new Map(rawLoadAgg.timestamps.map((t, i) => [t, rawLoadAgg.values[i]]));
  const rawPvMap = new Map(rawPvAgg.timestamps.map((t, i) => [t, rawPvAgg.values[i]]));

  renderChart(canvas, {
    type: 'bar',
    data: {
      labels: axis.labels,
      datasets: [
        makeForecastDataset('Load', allTs.map(t => loadMap.get(t) ?? null), SOLUTION_COLORS.g2l, 'load'),
        makeForecastDataset('Solar', allTs.map(t => pvMap.get(t) ?? null), SOLUTION_COLORS.pv2g, 'pv'),
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
                const rawMap = pt.dataset.series === 'pv' ? rawPvMap : rawLoadMap;
                const raw = rawMap.get(allTs[pt.dataIndex]);
                if (raw != null && Math.abs(raw - pt.raw) > 0.001) {
                  html += ttRow(toRGBA(pt.dataset.borderColor, 0.45), `Original ${pt.dataset.label.toLowerCase()}`, `${fmtKwh(raw)} kWh`);
                }
              }
              return html;
            },
          }),
          callbacks: { title: axis.tooltipTitleCb },
        },
      },
      scales: {
        x: { stacked: false },
        y: { stacked: false },
      },
    }),
    plugins: [
      makeAdjustmentOverlayPlugin(allTs, stepMinutes),
      makeForecastOriginalMarkersPlugin(allTs, { load: rawLoadMap, pv: rawPvMap }),
    ],
  });

  wireForecastChartEditing(canvas, allTs, stepMinutes);
}

function pickForecastBucket(event, canvas, timestamps, stepMinutes) {
  const chart = canvas._chart;
  if (!chart || !timestamps.length) return null;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const area = chart.chartArea;
  if (!area || x < area.left || x > area.right || y < area.top || y > area.bottom) return null;

  const rawIndex = chart.scales.x.getValueForPixel(x);
  const index = Math.max(0, Math.min(timestamps.length - 1, Math.round(Number(rawIndex))));
  const hit = chart.getElementsAtEventForMode(event, 'nearest', { intersect: true }, true)[0];
  const series = hit
    ? chart.data.datasets[hit.datasetIndex]?.series || 'load'
    : forecastSeriesFromCategoryX(x, categoryBounds(chart, index));
  const range = buildForecastSelectionRange(index, index, timestamps, stepMinutes);
  return { index, series, range };
}

function wireForecastChartEditing(canvas, timestamps, stepMinutes) {
  if (typeof canvas._forecastEditCleanup === 'function') canvas._forecastEditCleanup();

  const updateCursor = (event) => {
    canvas.style.cursor = pickForecastBucket(event, canvas, timestamps, stepMinutes) ? 'copy' : '';
  };

  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    const picked = pickForecastBucket(event, canvas, timestamps, stepMinutes);
    if (!picked) return;
    forecastChartDrag = {
      startIndex: picked.index,
      endIndex: picked.index,
      series: picked.series,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    forecastChartSelection = { ...picked.range, series: picked.series };
    canvas.setPointerCapture?.(event.pointerId);
    canvas._chart?.update('none');
  };

  const onPointerMove = (event) => {
    if (!forecastChartDrag) {
      updateCursor(event);
      return;
    }
    const picked = pickForecastBucket(event, canvas, timestamps, stepMinutes);
    if (!picked) return;
    const distance = Math.hypot(event.clientX - forecastChartDrag.startX, event.clientY - forecastChartDrag.startY);
    forecastChartDrag.moved = forecastChartDrag.moved || distance > 4 || picked.index !== forecastChartDrag.startIndex;
    forecastChartDrag.endIndex = picked.index;
    const range = buildForecastSelectionRange(forecastChartDrag.startIndex, forecastChartDrag.endIndex, timestamps, stepMinutes);
    forecastChartSelection = range ? { ...range, series: forecastChartDrag.series } : null;
    canvas._chart?.update('none');
  };

  const onPointerUp = (event) => {
    if (!forecastChartDrag) return;
    const drag = forecastChartDrag;
    forecastChartDrag = null;
    canvas.releasePointerCapture?.(event.pointerId);

    const range = buildForecastSelectionRange(drag.startIndex, drag.endIndex, timestamps, stepMinutes);
    if (!range) return;
    forecastChartSelection = { ...range, series: drag.series };
    canvas._chart?.update('none');

    const stepMs = stepMinutes * 60 * 1000;
    const clickedAdjustment = !drag.moved
      ? findAdjustmentAtBucket(timestamps[range.startIndex], timestamps[range.startIndex] + stepMs, drag.series)
      : null;

    if (clickedAdjustment) {
      openAdjustmentPopover({ adjustment: clickedAdjustment, anchorEvent: event });
    } else {
      openAdjustmentPopover({ selection: forecastChartSelection, anchorEvent: event });
    }
  };

  const onPointerCancel = () => {
    forecastChartDrag = null;
    forecastChartSelection = null;
    canvas.style.cursor = '';
    canvas._chart?.update('none');
  };

  const onPointerLeave = () => {
    if (!forecastChartDrag) canvas.style.cursor = '';
  };

  canvas.addEventListener('pointerenter', updateCursor);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas._forecastEditCleanup = () => {
    canvas.style.cursor = '';
    canvas.removeEventListener('pointerenter', updateCursor);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerCancel);
    canvas.removeEventListener('pointerleave', onPointerLeave);
  };
}

function activeSegmentClass(isActive) {
  return isActive
    ? 'bg-white text-sky-700 shadow-sm dark:bg-slate-700 dark:text-sky-200'
    : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100';
}

function seriesSegmentClass(series, isActive) {
  if (!isActive) return 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100';
  if (series === 'pv') return 'bg-amber-100 text-amber-800 shadow-sm dark:bg-amber-400/20 dark:text-amber-200';
  return 'bg-rose-100 text-rose-800 shadow-sm dark:bg-rose-400/20 dark:text-rose-200';
}

function refreshPopoverSegments() {
  for (const btn of document.querySelectorAll('.forecast-adjustment-series')) {
    const series = btn.dataset.adjustSeries || 'load';
    const active = series === adjustmentDraft?.series;
    btn.className = `forecast-adjustment-series rounded-md px-3 py-1.5 text-sm font-medium ${seriesSegmentClass(series, active)}`;
  }
  for (const btn of document.querySelectorAll('.forecast-adjustment-mode')) {
    const active = btn.dataset.adjustMode === adjustmentDraft?.mode;
    btn.className = `forecast-adjustment-mode rounded-md px-3 py-2 text-sm font-medium ${activeSegmentClass(active)}`;
  }
}

function setPopoverError(message = '') {
  const el = document.getElementById('forecast-adjustment-error');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('hidden', !message);
}

function showAdjustmentEditor() {
  const popover = document.getElementById('forecast-adjustment-popover');
  if (!popover) return;
  popover.classList.remove('hidden');
  popover.style.left = '';
  popover.style.top = '';
  popover.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function openAdjustmentPopover({ selection = null, adjustment = null } = {}) {
  const popover = document.getElementById('forecast-adjustment-popover');
  if (!popover) return;

  if (adjustment) {
    adjustmentDraft = {
      id: adjustment.id,
      series: adjustment.series,
      mode: adjustment.mode,
      value_W: adjustment.value_W,
      start: adjustment.start,
      end: adjustment.end,
    };
    forecastChartSelection = null;
  } else {
    const series = selection?.series || 'load';
    adjustmentDraft = {
      id: null,
      series,
      mode: series === 'pv' ? 'set' : 'add',
      value_W: series === 'pv' ? 0 : '',
      start: selection?.start || new Date().toISOString(),
      end: selection?.end || new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
  }

  setVal('forecast-adjustment-watts', adjustmentDraft.value_W);
  setVal('forecast-adjustment-start', toDatetimeLocalValue(adjustmentDraft.start));
  setVal('forecast-adjustment-end', toDatetimeLocalValue(adjustmentDraft.end));
  setEl('forecast-adjustment-title', adjustmentDraft.id ? 'Edit adjustment' : 'Manual adjustment');
  setEl('forecast-adjustment-range', formatRange(adjustmentDraft.start, adjustmentDraft.end));
  document.getElementById('forecast-adjustment-delete')?.classList.toggle('hidden', !adjustmentDraft.id);
  setPopoverError('');
  refreshPopoverSegments();
  showAdjustmentEditor();
}

function hideAdjustmentPopover() {
  document.getElementById('forecast-adjustment-popover')?.classList.add('hidden');
  adjustmentDraft = null;
  forecastChartSelection = null;
  document.getElementById('forecast-chart')?._chart?.update('none');
}

function readAdjustmentPayload() {
  if (!adjustmentDraft) return null;
  const start = fromDatetimeLocalValue(getVal('forecast-adjustment-start'));
  const end = fromDatetimeLocalValue(getVal('forecast-adjustment-end'));
  const value_W = Number(getVal('forecast-adjustment-watts'));
  if (!start || !end) throw new Error('Start and end must be valid.');
  if (new Date(end).getTime() <= new Date(start).getTime()) throw new Error('End must be after start.');
  if (!Number.isFinite(value_W)) throw new Error('Watts must be a number.');
  if (adjustmentDraft.mode === 'set' && value_W < 0) throw new Error('Set values cannot be negative.');
  return {
    series: adjustmentDraft.series,
    mode: adjustmentDraft.mode,
    value_W,
    start,
    end,
  };
}

async function saveAdjustmentFromPopover() {
  try {
    const payload = readAdjustmentPayload();
    if (!payload || !adjustmentDraft) return;
    const result = adjustmentDraft.id
      ? await updatePredictionAdjustment(adjustmentDraft.id, payload)
      : await createPredictionAdjustment(payload);
    setAdjustments(result.adjustments);
    hideAdjustmentPopover();
  } catch (err) {
    setPopoverError(err.message || String(err));
  }
}

async function deleteAdjustmentFromPopover() {
  if (!adjustmentDraft?.id) return;
  try {
    const result = await deletePredictionAdjustment(adjustmentDraft.id);
    setAdjustments(result.adjustments);
    hideAdjustmentPopover();
  } catch (err) {
    setPopoverError(err.message || String(err));
  }
}

function wireAdjustmentPopover() {
  document.getElementById('forecast-adjustment-cancel')?.addEventListener('click', hideAdjustmentPopover);
  document.getElementById('forecast-adjustment-save')?.addEventListener('click', saveAdjustmentFromPopover);
  document.getElementById('forecast-adjustment-delete')?.addEventListener('click', deleteAdjustmentFromPopover);
  for (const btn of document.querySelectorAll('.forecast-adjustment-series')) {
    btn.addEventListener('click', () => {
      if (!adjustmentDraft) return;
      adjustmentDraft.series = btn.dataset.adjustSeries || 'load';
      if (!adjustmentDraft.id) {
        adjustmentDraft.mode = adjustmentDraft.series === 'pv' ? 'set' : 'add';
        setVal('forecast-adjustment-watts', adjustmentDraft.series === 'pv' ? 0 : '');
      }
      refreshPopoverSegments();
    });
  }
  for (const btn of document.querySelectorAll('.forecast-adjustment-mode')) {
    btn.addEventListener('click', () => {
      if (!adjustmentDraft) return;
      adjustmentDraft.mode = btn.dataset.adjustMode || 'set';
      refreshPopoverSegments();
    });
  }
  for (const id of ['forecast-adjustment-start', 'forecast-adjustment-end']) {
    document.getElementById(id)?.addEventListener('change', () => {
      if (!adjustmentDraft) return;
      adjustmentDraft.start = fromDatetimeLocalValue(getVal('forecast-adjustment-start')) || adjustmentDraft.start;
      adjustmentDraft.end = fromDatetimeLocalValue(getVal('forecast-adjustment-end')) || adjustmentDraft.end;
      setEl('forecast-adjustment-range', formatRange(adjustmentDraft.start, adjustmentDraft.end));
    });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideAdjustmentPopover();
  });
}

function renderAdjustmentList() {
  const list = document.getElementById('prediction-adjustments-list');
  const count = document.getElementById('prediction-adjustments-count');
  if (!list) return;
  const sorted = [...predictionAdjustments].sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  if (count) count.textContent = sorted.length ? `${sorted.length} active` : '';
  if (!sorted.length) {
    list.innerHTML = '<div class="rounded-lg border border-dashed border-slate-200 px-3 py-2 text-sm text-slate-500 dark:border-white/10 dark:text-slate-400">No active adjustments. Click or drag on the forecast chart to add one.</div>';
    return;
  }
  list.innerHTML = '';
  for (const adj of sorted) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'flex w-full items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-sm hover:bg-slate-50 dark:border-white/10 dark:bg-slate-900 dark:hover:bg-slate-800';
    const colorClass = adj.series === 'pv' ? 'text-amber-600 dark:text-amber-300' : 'text-rose-600 dark:text-rose-300';
    item.innerHTML = `
      <span class="min-w-0">
        <span class="block truncate font-medium ${colorClass}">${escapeHtml(adjustmentSummary(adj))}</span>
        <span class="block truncate text-xs text-slate-500 dark:text-slate-400">${escapeHtml(formatRange(adj.start, adj.end))}${adj.label ? ` · ${escapeHtml(adj.label)}` : ''}</span>
      </span>
      <span class="shrink-0 text-xs font-medium text-slate-400 dark:text-slate-500">Edit</span>
    `;
    item.addEventListener('click', (event) => openAdjustmentPopover({ adjustment: adj, anchorEvent: event }));
    list.appendChild(item);
  }
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

function buildDayDividersPlugin(timestamps, dayNetWh, netErrorContainerId) {
  const daySpans = new Map();
  for (let i = 0; i < timestamps.length; i++) {
    const dateStr = new Date(timestamps[i]).toLocaleDateString('en-CA');
    if (!daySpans.has(dateStr)) daySpans.set(dateStr, { first: i, last: i });
    else daySpans.get(dateStr).last = i;
  }
  const days = [...daySpans.entries()];
  let lastChartGeometry = null; // skip HTML rebuild when horizontal geometry hasn't changed

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

      const geometry = `${chartArea.left},${chartArea.right}`;
      if (!netErrorContainerId || !dayNetWh || geometry === lastChartGeometry) return;
      lastChartGeometry = geometry;

      const container = document.getElementById(netErrorContainerId);
      if (!container) return;

      let html = `<div style="position:absolute;top:2px;left:${chartArea.left}px;font-size:9px;font-weight:600;letter-spacing:0.08em;color:rgba(148,163,184,0.45);text-transform:uppercase;">net error (kWh)</div>`;

      for (const [dateStr, { first, last }] of days) {
        const midX = (scales.x.getPixelForValue(first) + scales.x.getPixelForValue(last)) / 2;
        const netKwh = (dayNetWh.get(dateStr) ?? 0) / 1000;
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

  const dayNetWh = new Map();
  for (const d of sorted) {
    const actual = options.valueActual(d);
    const pred = options.valuePred(d);
    if (actual == null || pred == null) continue;
    const dateStr = new Date(d.time).toLocaleDateString('en-CA');
    dayNetWh.set(dateStr, (dayNetWh.get(dateStr) ?? 0) + (pred - actual));
  }

  const dayDividersPlugin = buildDayDividersPlugin(timestamps, dayNetWh, netErrorContainerId);
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

function renderHistoricalConfig(historicalPredictor) {
  if (!historicalPredictor) return;
  setVal('pred-active-sensor', historicalPredictor.sensor ?? '');
  setVal('pred-active-lookback', historicalPredictor.lookbackWeeks ?? '');
  setVal('pred-active-filter', historicalPredictor.dayFilter ?? '');
  setVal('pred-active-agg', historicalPredictor.aggregation ?? '');
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
