import { fmtKwh } from '../chart-tooltip.js';
import { getBuyPriceColor, toRGBA, SOLUTION_COLORS } from './colors.js';
import { fmtHHMM } from './core.js';

export const BUY_PRICE_STRIP_HEIGHT = 7;
export const BUY_PRICE_STRIP_GAP = 4;
export const BUY_PRICE_STRIP_TICK_PADDING = BUY_PRICE_STRIP_HEIGHT + BUY_PRICE_STRIP_GAP + 5;

const NEGATIVE_INJECTION_EPSILON_W = 1;
const NEGATIVE_INJECTION_ICON_SIZE = 13;
const NEGATIVE_INJECTION_ICON_MIN_SIZE = 7;
const NEGATIVE_INJECTION_DETAIL_LIMIT = 12;

export function makeRebalancingPlugin(startIdx, endIdx) {
  return {
    id: 'rebalancingShading',
    beforeDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea) return;
      const xScale = scales.x;
      const N = chart.data.labels?.length;
      if (!N) return;
      const barW = xScale.width / N;
      const x0 = Math.max(chartArea.left, xScale.left + startIdx * barW);
      const x1 = Math.min(chartArea.right, xScale.left + (endIdx + 1) * barW);
      if (x1 <= x0) return;

      ctx.save();
      ctx.fillStyle = 'rgba(56, 189, 248, 0.20)';
      ctx.fillRect(x0, chartArea.top, x1 - x0, chartArea.height);

      ctx.fillStyle = 'rgba(14, 165, 233, 0.70)';
      ctx.font = '500 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Rebalancing', (x0 + x1) / 2, chartArea.bottom - 8);
      ctx.restore();
    }
  };
}

function exportedPower_W(row) {
  return (Number(row?.pv2g) || 0) + (Number(row?.b2g) || 0);
}

function isNegativePriceInjection(row) {
  return (Number(row?.ec) || 0) < 0 && exportedPower_W(row) > NEGATIVE_INJECTION_EPSILON_W;
}

function fmtCostCents(v) {
  return `${v.toFixed(1)}¢`;
}

function getNegativeInjectionRanges(rows, h) {
  const ranges = [];
  let startIdx = null;

  function addRange(endIdx) {
    const start = rows[startIdx];
    const end = rows[endIdx];
    const endMs = (Number(end?.timestampMs) || 0) + h * 3600_000;
    let totalExport_kWh = 0;
    let totalCost_cents = 0;
    const slots = [];
    for (let i = startIdx; i <= endIdx; i++) {
      const row = rows[i];
      const export_kWh = exportedPower_W(row) * h / 1000;
      const sellPrice = Number(row?.ec) || 0;
      totalExport_kWh += export_kWh;
      totalCost_cents += Math.max(0, -sellPrice * export_kWh);
      slots.push({
        timeLabel: fmtHHMM(new Date(row.timestampMs)),
        exportLabel: fmtKwh(export_kWh),
        priceLabel: sellPrice.toFixed(1),
        costLabel: fmtCostCents(Math.max(0, -sellPrice * export_kWh)),
      });
    }

    ranges.push({
      startIdx,
      endIdx,
      timeLabel: `${fmtHHMM(new Date(start.timestampMs))}-${fmtHHMM(new Date(endMs))}`,
      exportLabel: `${fmtKwh(totalExport_kWh)} kWh`,
      costLabel: fmtCostCents(totalCost_cents),
      slots,
    });
  }

  rows.forEach((row, idx) => {
    if (isNegativePriceInjection(row)) {
      if (startIdx == null) startIdx = idx;
      return;
    }

    if (startIdx != null) {
      addRange(idx - 1);
      startIdx = null;
    }
  });

  if (startIdx != null) addRange(rows.length - 1);
  return ranges;
}

function drawNegativeInjectionIcon(ctx, x, y, dark, size = NEGATIVE_INJECTION_ICON_SIZE) {
  const radius = size / 2;
  const fontSize = Math.max(6, Math.round(size * 0.7));

  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = dark ? 'rgba(251, 191, 36, 0.10)' : 'rgba(245, 158, 11, 0.10)';
  ctx.strokeStyle = dark ? 'rgba(251, 191, 36, 0.35)' : 'rgba(180, 83, 9, 0.30)';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = dark ? 'rgba(251, 191, 36, 0.60)' : 'rgba(180, 83, 9, 0.55)';
  ctx.font = `500 ${fontSize}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('i', x, y + Math.max(0.25, size * 0.04));
  ctx.restore();
}

function ensureIconTooltip(chart) {
  const parent = chart.canvas.parentNode;
  if (!parent) return null;

  let el = parent.querySelector('.ov-icon-tt');
  if (!el) {
    el = document.createElement('div');
    el.className = 'ov-icon-tt';
    parent.style.position = 'relative';
    parent.appendChild(el);
  }
  return el;
}

function showNegativeInjectionTooltip(chart, hit, event) {
  const el = ensureIconTooltip(chart);
  if (!el) return;

  el.replaceChildren();

  const title = document.createElement('div');
  title.className = 'ov-icon-tt-title';
  title.textContent = 'Export at negative sell price';

  const summary = document.createElement('div');
  summary.className = 'ov-icon-tt-summary';
  for (const [label, value] of [
    ['Window', hit.timeLabel],
    ['Export', hit.exportLabel],
    ['Cost', hit.costLabel],
  ]) {
    const labelEl = document.createElement('span');
    labelEl.textContent = label;
    const valueEl = document.createElement('strong');
    valueEl.textContent = value;
    summary.append(labelEl, valueEl);
  }

  el.append(title, summary);

  if (hit.slots.length <= NEGATIVE_INJECTION_DETAIL_LIMIT) {
    const table = document.createElement('table');
    table.className = 'ov-icon-tt-table';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const label of ['Time', 'Sell', 'Export', 'Cost']) {
      const th = document.createElement('th');
      th.textContent = label;
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const slot of hit.slots) {
      const tr = document.createElement('tr');
      for (const value of [slot.timeLabel, `${slot.priceLabel}¢`, slot.exportLabel, slot.costLabel]) {
        const td = document.createElement('td');
        td.textContent = value;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    el.appendChild(table);
  }

  el.style.opacity = '1';

  const ttW = el.offsetWidth || 260;
  const ttH = el.offsetHeight || 120;
  const cW = chart.canvas.offsetWidth;
  const cH = chart.canvas.offsetHeight;
  let x = event.x + 12;
  if (x + ttW > cW - 8) x = event.x - ttW - 12;
  let y = event.y - ttH / 2;
  if (y < 0) y = 0;
  if (y + ttH > cH) y = Math.max(0, cH - ttH);

  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

function hideNegativeInjectionTooltip(chart) {
  const el = chart.canvas.parentNode?.querySelector('.ov-icon-tt');
  if (el) el.style.opacity = '0';
}

export function makeNegativePriceInjectionPlugin(rows, h) {
  const ranges = getNegativeInjectionRanges(rows, h);
  if (!ranges.length) return null;

  const iconHits = [];

  return {
    id: 'negativePriceInjectionShading',
    beforeDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea) return;
      const xScale = scales.x;
      const N = chart.data.labels?.length;
      if (!N) return;

      const barW = xScale.width / N;
      const dark = document.documentElement.classList.contains('dark');
      const fillStyle = dark ? 'rgba(245, 158, 11, 0.10)' : 'rgba(245, 158, 11, 0.08)';
      const iconY = chartArea.top + 13;

      ctx.save();
      iconHits.length = 0;

      for (const range of ranges) {
        const { startIdx, endIdx } = range;
        const x0 = Math.max(chartArea.left, xScale.left + startIdx * barW);
        const x1 = Math.min(chartArea.right, xScale.left + (endIdx + 1) * barW);
        if (x1 <= x0) continue;

        ctx.fillStyle = fillStyle;
        ctx.fillRect(x0, chartArea.top, x1 - x0, chartArea.height);

        const rangeWidth = x1 - x0;
        const iconSize = Math.max(
          NEGATIVE_INJECTION_ICON_MIN_SIZE,
          Math.min(NEGATIVE_INJECTION_ICON_SIZE, rangeWidth - 2)
        );
        const halfIcon = iconSize / 2;
        const iconX = rangeWidth < NEGATIVE_INJECTION_ICON_SIZE * 1.5
          ? (x0 + x1) / 2
          : Math.min(
              Math.max(x0 + NEGATIVE_INJECTION_ICON_SIZE, chartArea.left + halfIcon),
              x1 - halfIcon,
              chartArea.right - halfIcon
            );
        drawNegativeInjectionIcon(ctx, iconX, iconY, dark, iconSize);
        iconHits.push({
          ...range,
          left: iconX - iconSize,
          right: iconX + iconSize,
          top: iconY - iconSize,
          bottom: iconY + iconSize,
        });
      }

      ctx.restore();
    },
    afterEvent(chart, args) {
      const event = args.event;
      if (!event || event.type === 'mouseout') {
        hideNegativeInjectionTooltip(chart);
        chart.canvas.style.cursor = '';
        return;
      }

      const hit = iconHits.find(box =>
        event.x >= box.left &&
        event.x <= box.right &&
        event.y >= box.top &&
        event.y <= box.bottom
      );

      if (!hit) {
        hideNegativeInjectionTooltip(chart);
        chart.canvas.style.cursor = '';
        return;
      }

      chart.canvas.style.cursor = 'help';
      showNegativeInjectionTooltip(chart, hit, event);
    }
  };
}

export function makeBuyPriceStripPlugin(rows) {
  if (!rows?.length) return null;

  const colors = rows.map(row => getBuyPriceColor(row?.ic));

  return {
    id: 'buyPriceStrip',
    afterDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea) return;
      const xScale = scales.x;
      const N = chart.data.labels?.length;
      if (!xScale || !N) return;

      const y = chartArea.bottom + BUY_PRICE_STRIP_GAP;
      const h = BUY_PRICE_STRIP_HEIGHT;
      const barW = xScale.width / N;
      const count = Math.min(colors.length, N);

      ctx.save();
      for (let i = 0; i < count; i++) {
        const x0 = Math.max(chartArea.left, xScale.left + i * barW);
        const x1 = Math.min(chartArea.right, xScale.left + (i + 1) * barW);
        if (x1 <= x0) continue;
        ctx.fillStyle = colors[i];
        ctx.fillRect(x0, y, x1 - x0, h);
      }

      const dark = document.documentElement.classList.contains('dark');
      ctx.strokeStyle = dark ? 'rgba(15, 23, 42, 0.70)' : 'rgba(255, 255, 255, 0.85)';
      ctx.lineWidth = 1;
      ctx.strokeRect(chartArea.left, y, chartArea.right - chartArea.left, h);
      ctx.restore();
    }
  };
}

export function makeForecastOriginalMarkersPlugin(timestamps, rawSeriesMaps) {
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

export function makeAdjustmentOverlayPlugin({
  timestamps,
  stepMinutes,
  getAdjustments,
  getSelection,
  findAdjustmentIndexes,
  drawSeriesLane,
}) {
  return {
    id: 'predictionAdjustmentOverlay',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea } = chart;
      if (!chartArea || !timestamps.length) return;

      ctx.save();
      for (const adj of getAdjustments()) {
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

      const selection = getSelection();
      if (selection) {
        ctx.fillStyle = 'rgba(14, 165, 233, 0.10)';
        ctx.strokeStyle = 'rgba(14, 165, 233, 0.75)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
        for (let i = selection.startIndex; i <= selection.endIndex; i++) {
          drawSeriesLane(chart, i, selection.series, (left, width) => {
            ctx.fillRect(left, chartArea.top, width, chartArea.bottom - chartArea.top);
            ctx.strokeRect(left, chartArea.top + 1, width, chartArea.bottom - chartArea.top - 2);
          });
        }
      }
      ctx.restore();
    },
  };
}
