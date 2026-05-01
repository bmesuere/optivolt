import {
  createPredictionAdjustment,
  deletePredictionAdjustment,
  fetchPredictionAdjustments,
  updatePredictionAdjustment,
} from '../api/api.js';
import { escapeHtml, toDatetimeLocal } from '../utils.js';
import { buildTimeAxisFromTimestamps, getBaseOptions, renderChart, toRGBA, SOLUTION_COLORS } from '../charts.js';
import { createTooltipHandler, fmtKwh, getChartAnimations, ttHeader, ttRow } from '../chart-tooltip.js';
import {
  aggregateForecastKwh,
  buildForecastSelectionRange,
  forecastSeriesFromCategoryX,
} from './forecast-series.js';
import {
  makeAdjustmentOverlayPlugin,
  makeForecastOriginalMarkersPlugin,
} from '../charts/overlays.js';

const stripe = (c) => window.pattern?.draw('diagonal', c) || c;

export function createForecastChartController({ getForecasts, onAdjustmentsChanged = () => {} }) {
  let predictionAdjustments = [];
  let forecastChartSelection = null;
  let forecastChartDrag = null;
  let adjustmentDraft = null;

  function getAdjustments() {
    return predictionAdjustments;
  }

  function setAdjustments(nextAdjustments, { renderForecast = true } = {}) {
    predictionAdjustments = Array.isArray(nextAdjustments) ? nextAdjustments : [];
    onAdjustmentsChanged(predictionAdjustments);
    if (renderForecast) renderCombinedForecastChart();
    renderAdjustmentList();
  }

  async function loadAdjustments() {
    try {
      const result = await fetchPredictionAdjustments();
      setAdjustments(result?.adjustments, { renderForecast: false });
    } catch (err) {
      console.error('Failed to load prediction adjustments:', err);
    }
  }

  function renderCombinedForecastChart() {
    const canvas = document.getElementById('forecast-chart');
    if (!canvas) return;

    const { load, pv, rawLoad, rawPv } = getForecasts();
    const is15m = document.getElementById('forecast-chart-15m')?.checked;
    const stepMinutes = is15m ? 15 : 60;

    const loadAgg = load ? aggregateForecastKwh(load, stepMinutes) : { timestamps: [], values: [] };
    const pvAgg = pv ? aggregateForecastKwh(pv, stepMinutes) : { timestamps: [], values: [] };
    const rawLoadAgg = rawLoad ? aggregateForecastKwh(rawLoad, stepMinutes) : { timestamps: [], values: [] };
    const rawPvAgg = rawPv ? aggregateForecastKwh(rawPv, stepMinutes) : { timestamps: [], values: [] };

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
        makeAdjustmentOverlayPlugin({
          timestamps: allTs,
          stepMinutes,
          getAdjustments,
          getSelection: () => forecastChartSelection,
          findAdjustmentIndexes,
          drawSeriesLane,
        }),
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
    } else if (selection) {
      const series = selection?.series || 'load';
      adjustmentDraft = {
        id: null,
        series,
        mode: series === 'pv' ? 'set' : 'add',
        value_W: series === 'pv' ? 0 : '',
        start: selection?.start || new Date().toISOString(),
        end: selection?.end || new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      };
    } else {
      return;
    }

    setEl('forecast-adjustment-title', adjustmentDraft.id ? 'Edit adjustment' : 'Manual adjustment');
    setEl('forecast-adjustment-range', formatRange(adjustmentDraft.start, adjustmentDraft.end));
    setVal('forecast-adjustment-watts', adjustmentDraft.value_W);
    setVal('forecast-adjustment-start', toDatetimeLocal(new Date(adjustmentDraft.start)));
    setVal('forecast-adjustment-end', toDatetimeLocal(new Date(adjustmentDraft.end)));
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

  function findAdjustmentAtBucket(bucketStartMs, bucketEndMs, series = null) {
    return predictionAdjustments.findLast(adj => (!series || adj.series === series) && adjustmentOverlapsBucket(adj, bucketStartMs, bucketEndMs)) ?? null;
  }

  return {
    getAdjustments,
    loadAdjustments,
    render: renderCombinedForecastChart,
    setAdjustments,
    wireAdjustmentPopover,
  };
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

function fromDatetimeLocalValue(value) {
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? new Date(ts).toISOString() : '';
}

function adjustmentSummary(adj) {
  const modeText = adj.mode === 'set' ? 'set to' : 'add';
  const sign = adj.mode === 'add' && adj.value_W > 0 ? '+' : '';
  return `${adj.series === 'pv' ? 'PV' : 'Load'} ${modeText} ${sign}${Math.round(adj.value_W).toLocaleString()} W`;
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

function adjustmentOverlapsBucket(adj, bucketStartMs, bucketEndMs) {
  return new Date(adj.start).getTime() < bucketEndMs && new Date(adj.end).getTime() > bucketStartMs;
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

function setPopoverError(message = '') {
  const el = document.getElementById('forecast-adjustment-error');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('hidden', !message);
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
