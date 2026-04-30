/* global Chart */
import {
  createTooltipHandler, fmtKwh, getChartAnimations,
  ttHeader, ttRow, ttSection, ttDivider, ttPrices,
} from './chart-tooltip.js';

export const SOLUTION_COLORS = {
  b2g: "rgb(15, 192, 216)",   // Battery to Grid (teal-ish)
  pv2g: "rgb(247, 171, 62)",  // Solar to Grid (amber)
  pv2b: "rgb(139, 201, 100)", // Solar to Battery (green)
  pv2l: "rgb(212, 222, 95)",  // Solar to Consumption (yellow-green)
  b2l: "rgb(71, 144, 208)",   // Battery to Consumption (blue)
  g2l: "rgb(233, 122, 131)",  // Grid to Consumption (red)
  g2b: "rgb(225, 142, 233)",  // Grid to Battery (purple)
  soc: "rgb(71, 144, 208)",   // SoC line color = battery-ish blue
  g2ev: "rgb(185, 38, 55)",   // Grid to EV (dark red — variant of g2l)
  pv2ev: "rgb(142, 158, 22)", // Solar to EV (dark yellow-green — variant of pv2l)
  b2ev: "rgb(20, 78, 160)",   // Battery to EV (dark blue — variant of b2l)
  ev_charge: "rgb(16, 185, 129)", // EV total (emerald — distinct EV colour)
};

// Short labels used in the flows tooltip (→ instead of "to", "Load" instead of "Consumption")
const FLOWS_TOOLTIP_LABELS = {
  pv2l:  "Solar → Load",
  pv2ev: "Solar → EV",
  pv2b:  "Solar → Battery",
  pv2g:  "Solar → Grid",
  b2g:   "Battery → Grid",
  b2l:   "Battery → Load",
  b2ev:  "Battery → EV",
  g2l:   "Grid → Load",
  g2ev:  "Grid → EV",
  g2b:   "Grid → Battery",
};

const NEGATIVE_INJECTION_EPSILON_W = 1;
const NEGATIVE_INJECTION_ICON_SIZE = 13;
const NEGATIVE_INJECTION_DETAIL_LIMIT = 12;
const BUY_PRICE_STRIP_HEIGHT = 7;
const BUY_PRICE_STRIP_GAP = 4;
const BUY_PRICE_STRIP_TICK_PADDING = BUY_PRICE_STRIP_HEIGHT + BUY_PRICE_STRIP_GAP + 5;

const BUY_PRICE_COLOR_NEUTRAL_RGB = [226, 232, 240];
const BUY_PRICE_COLOR_STOPS = [
  { value: -10, rgb: [37, 99, 235] },
  { value: -1,  rgb: [96, 165, 250] },
  { value: 0,   rgb: BUY_PRICE_COLOR_NEUTRAL_RGB }, // zero / neutral
  { value: 1,   rgb: [254, 243, 199] },
  { value: 12,  rgb: [251, 191, 36] },
  { value: 24,  rgb: [249, 115, 22] },
  { value: 35,  rgb: [220, 38, 38] },
];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function srgbToLinear(channel) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel) {
  const c = Math.max(0, Math.min(1, channel));
  const srgb = c <= 0.0031308 ? 12.92 * c : 1.055 * (c ** (1 / 2.4)) - 0.055;
  return Math.round(srgb * 255);
}

function rgbToOklab(rgb) {
  const r = srgbToLinear(rgb[0]);
  const g = srgbToLinear(rgb[1]);
  const b = srgbToLinear(rgb[2]);

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const lRoot = Math.cbrt(l);
  const mRoot = Math.cbrt(m);
  const sRoot = Math.cbrt(s);

  return [
    0.2104542553 * lRoot + 0.7936177850 * mRoot - 0.0040720468 * sRoot,
    1.9779984951 * lRoot - 2.4285922050 * mRoot + 0.4505937099 * sRoot,
    0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.8086757660 * sRoot,
  ];
}

function oklabToRgb(oklab) {
  const lRoot = oklab[0] + 0.3963377774 * oklab[1] + 0.2158037573 * oklab[2];
  const mRoot = oklab[0] - 0.1055613458 * oklab[1] - 0.0638541728 * oklab[2];
  const sRoot = oklab[0] - 0.0894841775 * oklab[1] - 1.2914855480 * oklab[2];

  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;

  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  ];
}

function interpolateOklab(from, to, t) {
  const fromLab = rgbToOklab(from);
  const toLab = rgbToOklab(to);
  return oklabToRgb(fromLab.map((channel, idx) => lerp(channel, toLab[idx], t)));
}

function rgbString(rgb) {
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

export function getBuyPriceColor(price_cents_per_kWh) {
  const price = Number(price_cents_per_kWh);
  if (!Number.isFinite(price)) return rgbString(BUY_PRICE_COLOR_NEUTRAL_RGB);

  const first = BUY_PRICE_COLOR_STOPS[0];
  const last = BUY_PRICE_COLOR_STOPS[BUY_PRICE_COLOR_STOPS.length - 1];
  if (price <= first.value) return rgbString(first.rgb);
  if (price >= last.value) return rgbString(last.rgb);

  for (let i = 1; i < BUY_PRICE_COLOR_STOPS.length; i++) {
    const lower = BUY_PRICE_COLOR_STOPS[i - 1];
    const upper = BUY_PRICE_COLOR_STOPS[i];
    if (price <= upper.value) {
      const t = (price - lower.value) / (upper.value - lower.value);
      return rgbString(interpolateOklab(lower.rgb, upper.rgb, t));
    }
  }

  return rgbString(last.rgb);
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

function makeFlowsTooltip(rows, flowSpecs, h) {
  const W2kWh = (x) => (x || 0) * h / 1000;

  return createTooltipHandler({
    renderContent: (idx, tooltip) => {
      const row = rows[idx];
      const time = tooltip.title?.[0] ?? "";

      const posRows = flowSpecs.filter(s => s.sign === 1  && (row[s.key] || 0) !== 0);
      const negRows = flowSpecs.filter(s => s.sign === -1 && (row[s.key] || 0) !== 0);

      let html = ttHeader(time, `SoC <strong>${Math.round(row.soc_percent)}%</strong>`);

      if (posRows.length) {
        html += ttSection("↑ Sources");
        for (const s of posRows) {
          html += ttRow(s.color, FLOWS_TOOLTIP_LABELS[s.key] ?? s.label, `${fmtKwh(W2kWh(row[s.key]))} kWh`);
        }
      }

      if (posRows.length && negRows.length) html += ttDivider();

      if (negRows.length) {
        html += ttSection("↓ Draws");
        for (const s of negRows) {
          html += ttRow(s.color, FLOWS_TOOLTIP_LABELS[s.key] ?? s.label, `${fmtKwh(W2kWh(row[s.key]))} kWh`);
        }
      }

      html += ttDivider();
      html += ttPrices(`${row.ic.toFixed(1)}¢`, `${row.ec.toFixed(1)}¢`);
      return html;
    },
  });
}

export const toRGBA = (rgb, alpha = 1) => {
  const m = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(rgb);
  return m ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})` : rgb;
};
const dim = (rgb) => toRGBA(rgb, 0.6);

// ---------------------- Time & Axis Helpers ----------------------

export function fmtHHMM(dt) {
  const HH = String(dt.getHours()).padStart(2, "0");
  const MM = String(dt.getMinutes()).padStart(2, "0");
  return `${HH}:${MM}`;
}

function fmtTickHourOrDate(dt) {
  const mins = dt.getMinutes();
  if (mins !== 0) return "";
  const hrs = dt.getHours();
  if (hrs === 0) {
    const dd = String(dt.getDate()).padStart(2, "0");
    const mm = String(dt.getMonth() + 1).padStart(2, "0");
    return `${dd}/${mm}`;
  }
  return `${String(hrs).padStart(2, "0")}:00`;
}

export function buildTimeAxisFromTimestamps(timestampsMs) {
  const times = timestampsMs.map(ms => new Date(ms));
  let hoursSpan = 0;
  if (times.length > 1) {
    hoursSpan = (times[times.length - 1] - times[0]) / (3600 * 1000);
  }

  /* Modified to handle 7-day range better */
  const daysSpan = hoursSpan / 24;

  let labelEveryH = 3;
  let sparseMode = hoursSpan > 12;

  // Very sparse mode for > 2 days
  if (daysSpan > 2) {
    labelEveryH = 24; // Only Midnight
  } else if (hoursSpan > 12) {
    labelEveryH = 4; // Every 4h
  } else {
    labelEveryH = 2; // Every 2h
  }

  function isMidnight(dt) { return dt.getHours() === 0 && dt.getMinutes() === 0; }
  function isFullMinute(dt) { return dt.getMinutes() === 0; }

  function isLabeledHour(dt) {
    if (isMidnight(dt)) return true;
    if (!isFullMinute(dt)) return false;
    return !sparseMode || (dt.getHours() % labelEveryH) === 0;
  }

  const labels = times.map(dt => fmtHHMM(dt));

  return {
    labels,
    ticksCb: (val, idx) => {
      const dt = times[idx];
      return (dt && isLabeledHour(dt)) ? fmtTickHourOrDate(dt) : "";
    },
    tooltipTitleCb: (items) => {
      const idx = items?.[0]?.dataIndex;
      return times[idx] ? fmtHHMM(times[idx]) : "";
    },
    gridCb: (ctx) => {
      let idx = ctx.index ?? ctx.tick?.index ?? ctx.tick?.value;
      if (idx == null || !times[idx]) return "transparent";
      const dt = times[idx];
      if (isMidnight(dt)) return getChartTheme().majorGridColor;
      if (isLabeledHour(dt) && isFullMinute(dt)) return getChartTheme().minorGridColor;
      return "transparent";
    }
  };
}

// ---------------------- Rebalancing Shading Plugin ----------------------

/**
 * Returns an inline Chart.js plugin that shades a contiguous band of bars
 * to visualise the rebalancing hold window.
 */
function makeRebalancingPlugin(startIdx, endIdx) {
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
      ctx.fillStyle = 'rgba(56, 189, 248, 0.20)'; // sky-400 tint
      ctx.fillRect(x0, chartArea.top, x1 - x0, chartArea.height);

      // Label at the bottom of the shaded region
      ctx.fillStyle = 'rgba(14, 165, 233, 0.70)'; // sky-500
      ctx.font = '500 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Rebalancing', (x0 + x1) / 2, chartArea.bottom - 8);
      ctx.restore();
    }
  };
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

function drawNegativeInjectionIcon(ctx, x, y, dark) {
  const radius = NEGATIVE_INJECTION_ICON_SIZE / 2;

  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = dark ? 'rgba(251, 191, 36, 0.10)' : 'rgba(245, 158, 11, 0.10)';
  ctx.strokeStyle = dark ? 'rgba(251, 191, 36, 0.35)' : 'rgba(180, 83, 9, 0.30)';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = dark ? 'rgba(251, 191, 36, 0.60)' : 'rgba(180, 83, 9, 0.55)';
  ctx.font = '500 9px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('i', x, y + 0.5);
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

function makeNegativePriceInjectionPlugin(rows, h) {
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

        const iconX = Math.min(
          Math.max(x0 + 13, chartArea.left + NEGATIVE_INJECTION_ICON_SIZE),
          x1 - NEGATIVE_INJECTION_ICON_SIZE / 2,
          chartArea.right - NEGATIVE_INJECTION_ICON_SIZE
        );
        drawNegativeInjectionIcon(ctx, iconX, iconY, dark);
        iconHits.push({
          ...range,
          left: iconX - NEGATIVE_INJECTION_ICON_SIZE,
          right: iconX + NEGATIVE_INJECTION_ICON_SIZE,
          top: iconY - NEGATIVE_INJECTION_ICON_SIZE,
          bottom: iconY + NEGATIVE_INJECTION_ICON_SIZE,
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

function makeBuyPriceStripPlugin(rows) {
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

// ---------------------- Chart Configuration Helpers ----------------------

/**
 * Generates the standard Chart.js options object used by all 4 charts.
 * Allows overriding specific sections via `overrides`.
 */
export function getBaseOptions({ ticksCb, tooltipTitleCb, gridCb, yTitle, stacked = false }, overrides = {}) {
  const theme = getChartTheme();
  const fontFamily = getComputedStyle(document.documentElement).fontFamily;
  const { ticks: xTicks, grid: xGrid, ...xRest } = overrides.scales?.x || {};

  const legendSquare = {
    position: "bottom",
    labels: {
      color: theme.axisTickColor,
      usePointStyle: true,
      pointStyle: "rect",
      boxWidth: 10,
      padding: 12,
      font: { size: 12, family: fontFamily }
    }
  };
  const { legend: legendOverrides, tooltip: tooltipOverrides, ...pluginOverrides } = overrides.plugins || {};

  // Deep merge for plugins/scales is often needed, but simple spread works for this specific file structure
  const options = {
    maintainAspectRatio: false,
    responsive: true,
    interaction: { mode: "index", intersect: false },
    layout: { padding: { bottom: overrides.layout?.padding?.bottom ?? -6 } },
    ...('animation' in overrides ? { animation: overrides.animation } : {}),
    plugins: {
      legend: {
        ...legendSquare,
        ...(legendOverrides || {}),
        labels: {
          ...legendSquare.labels,
          ...(legendOverrides?.labels || {}),
        },
      },
      tooltip: {
        mode: "index",
        intersect: false,
        callbacks: { title: tooltipTitleCb },
        ...(tooltipOverrides || {}),
      },
      ...pluginOverrides
    },
    scales: {
      x: {
        stacked,
        ...xRest,
        ticks: {
          color: theme.axisTickColor,
          callback: ticksCb,
          autoSkip: false,
          maxRotation: 0,
          minRotation: 0,
          ...(xTicks || {})
        },
        grid: { color: gridCb, drawTicks: true, ...(xGrid || {}) }
      },
      y: {
        stacked,
        beginAtZero: true,
        ticks: { color: theme.axisTickColor },
        grid: {
          color: theme.gridColor,
          drawTicks: false,
          zeroLineColor: theme.zeroLineColor
        },
        title: { display: !!yTitle, text: yTitle, color: theme.axisTickColor },
        // If specific charts need Y overrides (like max: 100), merge them here:
        ...(overrides.scales?.y || {})
      }
    }
  };
  return options;
}

export function getChartTheme() {
  const dark = document.documentElement.classList.contains('dark');
  if (dark) {
    return {
      axisTickColor: 'rgba(226, 232, 240, 0.9)',    // slate-200-ish
      gridColor: 'rgba(148, 163, 184, 0.28)',       // slate-400-ish, soft
      zeroLineColor: 'rgba(148, 163, 184, 0.6)',    // a bit stronger
      majorGridColor: 'rgba(226, 232, 240, 0.32)',
      minorGridColor: 'rgba(226, 232, 240, 0.10)',
    };
  }
  return {
    axisTickColor: 'rgba(71, 85, 105, 0.95)',       // slate-600-ish
    gridColor: 'rgba(148, 163, 184, 0.22)',         // light grey grid
    zeroLineColor: 'rgba(148, 163, 184, 0.6)',
    majorGridColor: 'rgba(0, 0, 0, 0.25)',
    minorGridColor: 'rgba(0, 0, 0, 0.08)',
  };
}

const chartRegistry = new Set();

function updateLegendTheme(options, theme, fontFamily) {
  const legend = options.plugins?.legend;
  if (!legend) return;
  legend.labels = {
    ...(legend.labels || {}),
    color: theme.axisTickColor,
    font: {
      ...(legend.labels?.font || {}),
      family: fontFamily,
    },
  };
}

function updateScaleTheme(scaleOptions, theme, scaleId) {
  if (!scaleOptions) return;

  if (scaleId !== "y2") {
    scaleOptions.ticks = {
      ...(scaleOptions.ticks || {}),
      color: theme.axisTickColor,
    };
  }

  if (scaleOptions.title) {
    scaleOptions.title = {
      ...scaleOptions.title,
      color: theme.axisTickColor,
    };
  }

  if (scaleOptions.grid) {
    scaleOptions.grid = {
      ...scaleOptions.grid,
      ...(typeof scaleOptions.grid.color === "function" ? {} : { color: theme.gridColor }),
      ...(Object.hasOwn(scaleOptions.grid, "zeroLineColor") ? { zeroLineColor: theme.zeroLineColor } : {}),
    };
  }
}

function getRenderedCharts() {
  const charts = new Set();
  for (const chart of chartRegistry) {
    if (chart?.canvas?.isConnected) charts.add(chart);
    else chartRegistry.delete(chart);
  }

  if (typeof document !== "undefined") {
    for (const canvas of document.querySelectorAll("canvas")) {
      const chart = canvas._chart || Chart.getChart?.(canvas);
      if (chart) charts.add(chart);
    }
  }

  return charts;
}

export function refreshAllChartThemes() {
  const theme = getChartTheme();
  const fontFamily = getComputedStyle(document.documentElement).fontFamily;

  for (const chart of getRenderedCharts()) {
    const options = chart.options || {};
    updateLegendTheme(options, theme, fontFamily);

    for (const [scaleId, scaleOptions] of Object.entries(options.scales || {})) {
      updateScaleTheme(scaleOptions, theme, scaleId);
    }

    chart.update("none");
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("optivolt:themechange", refreshAllChartThemes);
}

/**
 * Handles the destruction of old chart instances and creation of new ones.
 */
export function renderChart(canvas, config) {
  if (canvas._chart) {
    chartRegistry.delete(canvas._chart);
    canvas._chart.destroy();
  }
  canvas._chart = new Chart(canvas.getContext("2d"), config);
  chartRegistry.add(canvas._chart);
  const overlay = canvas.parentElement?.querySelector('.chart-empty');
  if (overlay) overlay.style.display = 'none';
}

// Helper for signed stacked bars
const dsBar = (label, data, color, stack) => ({
  label, data, stack,
  type: "bar",
  backgroundColor: color,
  hoverBackgroundColor: dim(color),
  borderColor: color,
  borderWidth: 0.5
});


// -----------------------------------------------------------------------------
// 1) Power flows bar chart (signed kWh, stacked)
// -----------------------------------------------------------------------------

export function drawFlowsBarStackSigned(canvas, rows, stepSize_m = 15, rebalanceWindow = null, evSettings = null) {
  const timestampsMs = rows.map(r => r.timestampMs);
  const axis = buildTimeAxisFromTimestamps(timestampsMs);

  const h = Math.max(0.000001, Number(stepSize_m) / 60);
  const W2kWh = (x) => (x || 0) * h / 1000;

  const stackId = "flows";

  // Define structure: key -> params
  const flowSpecs = [
    // Positive Stack
    { key: "pv2l",  color: SOLUTION_COLORS.pv2l,  label: "Solar → Load",     sign: 1 },
    { key: "pv2ev", color: SOLUTION_COLORS.pv2ev, label: "Solar → EV",       sign: 1 },
    { key: "pv2b",  color: SOLUTION_COLORS.pv2b,  label: "Solar → Battery",  sign: 1 },
    { key: "pv2g",  color: SOLUTION_COLORS.pv2g,  label: "Solar → Grid",     sign: 1 },
    { key: "b2g",   color: SOLUTION_COLORS.b2g,   label: "Battery → Grid",   sign: 1 },
    // Negative Stack
    { key: "b2l",   color: SOLUTION_COLORS.b2l,   label: "Battery → Load",   sign: -1 },
    { key: "b2ev",  color: SOLUTION_COLORS.b2ev,  label: "Battery → EV",     sign: -1 },
    { key: "g2l",   color: SOLUTION_COLORS.g2l,   label: "Grid → Load",      sign: -1 },
    { key: "g2ev",  color: SOLUTION_COLORS.g2ev,  label: "Grid → EV",        sign: -1 },
    { key: "g2b",   color: SOLUTION_COLORS.g2b,   label: "Grid → Battery",   sign: -1 },
  ];

  const nonZeroKeys = new Set();
  for (const r of rows) for (const { key } of flowSpecs) if ((r[key] || 0) !== 0) nonZeroKeys.add(key);
  const datasets = flowSpecs
    .filter(spec => nonZeroKeys.has(spec.key))
    .map(spec =>
      dsBar(
        spec.label,
        rows.map(r => spec.sign * Math.abs(W2kWh(r[spec.key]))),
        spec.color,
        stackId
      )
    );

  const plugins = rebalanceWindow
    ? [makeRebalancingPlugin(rebalanceWindow.startIdx, rebalanceWindow.endIdx)]
    : [];
  const buyPriceStripPlugin = makeBuyPriceStripPlugin(rows);
  if (buyPriceStripPlugin) plugins.push(buyPriceStripPlugin);
  const negativeInjectionPlugin = makeNegativePriceInjectionPlugin(rows, h);
  if (negativeInjectionPlugin) plugins.push(negativeInjectionPlugin);
  const depPlugin = evSettings?.departureTime
    ? makeEvDeparturePlugin(rows, evSettings.departureTime)
    : null;
  if (depPlugin) plugins.push(depPlugin);

  renderChart(canvas, {
    type: "bar",
    data: { labels: axis.labels, datasets },
    options: getBaseOptions({ ...axis, yTitle: "kWh", stacked: true }, {
      ...getChartAnimations('bar', rows.length),
      plugins: {
        tooltip: {
          mode: "index",
          intersect: false,
          enabled: false,
          external: makeFlowsTooltip(rows, flowSpecs, h),
          callbacks: { title: axis.tooltipTitleCb },
        }
      },
      layout: { padding: { bottom: 0 } },
      scales: {
        x: {
          ticks: { padding: BUY_PRICE_STRIP_TICK_PADDING },
        },
      },
    }),
    plugins,
  });
}

// -----------------------------------------------------------------------------
// 2) SoC line chart (%)
// -----------------------------------------------------------------------------

export function drawSocChart(canvas, rows, _stepSize_m = 15, evSettings = null) {
  const timestampsMs = rows.map(r => r.timestampMs);
  const axis = buildTimeAxisFromTimestamps(timestampsMs);

  const hasEvSoc = rows.some(r => (r.ev_soc_percent ?? 0) > 0);

  const makeSocGradient = (color) => (context) => {
    const { chart } = context;
    const { ctx, chartArea } = chart;
    if (!chartArea) return toRGBA(color, 0.15);
    const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    gradient.addColorStop(0, toRGBA(color, 0.25));
    gradient.addColorStop(1, toRGBA(color, 0));
    return gradient;
  };

  const datasets = [{
    label: "Battery SoC (%)",
    data: rows.map(r => r.soc_percent),
    borderColor: SOLUTION_COLORS.soc,
    backgroundColor: makeSocGradient(SOLUTION_COLORS.soc),
    fill: 'origin',
    borderWidth: 2,
    tension: 0.2,
    pointRadius: 0,
    hoverBorderColor: dim(SOLUTION_COLORS.soc),
    clip: false
  }];

  if (hasEvSoc) {
    datasets.push({
      label: "EV SoC (%)",
      data: rows.map(r => r.ev_soc_percent ?? 0),
      borderColor: SOLUTION_COLORS.ev_charge,
      backgroundColor: makeSocGradient(SOLUTION_COLORS.ev_charge),
      fill: 'origin',
      borderWidth: 2,
      tension: 0.2,
      pointRadius: 0,
      hoverBorderColor: dim(SOLUTION_COLORS.ev_charge),
      clip: false
    });
  }

  const evTargetPlugin = evSettings
    ? makeEvTargetPlugin(rows, evSettings.departureTime, evSettings.targetSoc_percent)
    : null;

  renderChart(canvas, {
    type: "line",
    data: { labels: axis.labels, datasets },
    options: getBaseOptions({ ...axis, yTitle: "%" }, {
      ...getChartAnimations('line', rows.length),
      plugins: {
        ...(hasEvSoc ? {} : { legend: { display: false } }),
        tooltip: {
          mode: "index",
          intersect: false,
          enabled: false,
          external: createTooltipHandler({
            renderContent: (_idx, tooltip) => {
              const time = tooltip.title?.[0] ?? "";
              let html = ttHeader(time);
              for (const pt of (tooltip.dataPoints ?? [])) {
                html += ttRow(pt.dataset.borderColor, pt.dataset.label, `${Math.round(pt.raw)}%`);
              }
              return html;
            },
          }),
          callbacks: { title: axis.tooltipTitleCb },
        },
      },
      layout: hasEvSoc ? undefined : { padding: { bottom: 0 } },
      scales: { y: { max: 100 } }
    }),
    plugins: evTargetPlugin ? [evTargetPlugin] : [],
  });
}

// -----------------------------------------------------------------------------
// 3) Buy/Sell price chart (stepped line)
// -----------------------------------------------------------------------------

function makePriceZeroLinePlugin() {
  return {
    id: 'priceZeroLine',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      const yScale = scales.y;
      if (!chartArea || !yScale || yScale.min > 0 || yScale.max < 0) return;

      const y = yScale.getPixelForValue(0);
      if (y < chartArea.top || y > chartArea.bottom) return;

      ctx.save();
      ctx.strokeStyle = getChartTheme().majorGridColor;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(chartArea.left, y);
      ctx.lineTo(chartArea.right, y);
      ctx.stroke();
      ctx.restore();
    }
  };
}

export function drawPricesStepLines(canvas, rows, _stepSize_m = 15) {
  const timestampsMs = rows.map(r => r.timestampMs);
  const axis = buildTimeAxisFromTimestamps(timestampsMs);
  const strokeW = (axis.labels.length > 48) ? 1 : 2;

  const commonLine = {
    stepped: true,
    borderWidth: strokeW,
    pointRadius: 0,
    pointHitRadius: 8
  };

  renderChart(canvas, {
    type: "line",
    data: {
      labels: axis.labels,
      datasets: [
        {
          label: "Buy price",
          data: rows.map(r => r.ic),
          borderColor: "#ef4444",
          backgroundColor: "#ef4444",
          ...commonLine
        },
        {
          label: "Sell price",
          data: rows.map(r => r.ec),
          borderColor: "#22c55e",
          backgroundColor: "#22c55e",
          ...commonLine
        }
      ]
    },
    options: getBaseOptions({ ...axis, yTitle: "c€/kWh" }, {
      ...getChartAnimations('line', rows.length),
      plugins: {
        tooltip: {
          mode: "index",
          intersect: false,
          enabled: false,
          external: createTooltipHandler({
            renderContent: (_idx, tooltip) => {
              const time = tooltip.title?.[0] ?? "";
              let html = ttHeader(time);
              for (const pt of (tooltip.dataPoints ?? [])) {
                html += ttRow(pt.dataset.borderColor, pt.dataset.label, `${pt.raw.toFixed(1)} c€/kWh`);
              }
              return html;
            },
          }),
          callbacks: { title: axis.tooltipTitleCb },
        },
      },
    }),
    plugins: [makePriceZeroLinePlugin()]
  });
}

export function aggregateLoadPvBuckets(rows, stepSize_m = 15) {
  const stepHours = Math.max(0.000001, Number(stepSize_m) / 60);
  const W2kWh = (x) => (x || 0) * stepHours / 1000;

  const hourMap = new Map();

  for (const row of rows) {
    const dt = new Date(row.timestampMs);
    dt.setMinutes(0, 0, 0); // Round to start of hour
    const hourMs = dt.getTime();

    if (!hourMap.has(hourMs)) {
      hourMap.set(hourMs, {
        dtHour: dt,
        loadKWh: 0,
        pvKWh: 0,
        originalLoadKWh: 0,
        originalPvKWh: 0,
        hasOriginalLoad: false,
        hasOriginalPv: false,
      });
    }
    const bucket = hourMap.get(hourMs);
    bucket.loadKWh += W2kWh(row.load);
    bucket.pvKWh += W2kWh(row.pv);
    bucket.originalLoadKWh += W2kWh(row.originalLoad ?? row.load);
    bucket.originalPvKWh += W2kWh(row.originalPv ?? row.pv);
    bucket.hasOriginalLoad ||= row.originalLoad != null;
    bucket.hasOriginalPv ||= row.originalPv != null;
  }

  return [...hourMap.values()].sort((a, b) => a.dtHour - b.dtHour);
}

// -----------------------------------------------------------------------------
// 4) Forecast grouped bars (hourly aggregation)
// -----------------------------------------------------------------------------

export function drawLoadPvGrouped(canvas, rows, stepSize_m = 15) {
  const buckets = aggregateLoadPvBuckets(rows, stepSize_m);

  // Build axis based on aggregated timestamps
  const axis = buildTimeAxisFromTimestamps(buckets.map(b => b.dtHour.getTime()));

  const stripe = (c) => window.pattern?.draw("diagonal", c) || c;
  const ds = (label, data, color, series) => ({
    label, data,
    series,
    backgroundColor: stripe(color),
    borderColor: color,
    borderWidth: 1,
    hoverBackgroundColor: stripe(dim(color))
  });

  renderChart(canvas, {
    type: "bar",
    data: {
      labels: axis.labels,
      datasets: [
        ds("Consumption forecast", buckets.map(b => b.loadKWh), SOLUTION_COLORS.g2l, "load"),
        ds("Solar forecast", buckets.map(b => b.pvKWh), SOLUTION_COLORS.pv2g, "pv")
      ]
    },
    options: getBaseOptions({ ...axis, yTitle: "kWh" }, {
      ...getChartAnimations('bar', buckets.length),
      plugins: {
        tooltip: {
          mode: "index",
          intersect: false,
          enabled: false,
          external: createTooltipHandler({
            renderContent: (_idx, tooltip) => {
              const time = tooltip.title?.[0] ?? "";
              let html = ttHeader(time);
              for (const pt of (tooltip.dataPoints ?? [])) {
                if (pt.raw == null) continue;
                html += ttRow(pt.dataset.borderColor, pt.dataset.label, `${fmtKwh(pt.raw)} kWh`);
                const bucket = buckets[pt.dataIndex];
                const original = pt.dataset.series === "pv" ? bucket?.originalPvKWh : bucket?.originalLoadKWh;
                const hasOriginal = pt.dataset.series === "pv" ? bucket?.hasOriginalPv : bucket?.hasOriginalLoad;
                if (hasOriginal && original != null && Math.abs(original - pt.raw) > 0.001) {
                  html += ttRow(
                    toRGBA(pt.dataset.borderColor, 0.45),
                    `Original ${pt.dataset.label.toLowerCase()}`,
                    `${fmtKwh(original)} kWh`,
                  );
                }
              }
              return html;
            },
          }),
          callbacks: { title: axis.tooltipTitleCb },
        },
      },
    })
  });
}

// -----------------------------------------------------------------------------
// EV tab charts
// -----------------------------------------------------------------------------

export function drawEvPowerChart(canvas, rows, _stepSize_m = 15, evSettings = {}) {
  const timestampsMs = rows.map(r => r.timestampMs);
  const axis = buildTimeAxisFromTimestamps(timestampsMs);

  const theme = getChartTheme();

  const toSourceAmps = (r, key) => {
    const total_W = (r.g2ev || 0) + (r.pv2ev || 0) + (r.b2ev || 0);
    const ev_A = r.ev_charge_A || 0;
    return total_W > 0 ? ev_A * (r[key] || 0) / total_W : 0;
  };

  const datasets = [
    dsBar("Grid", rows.map(r => toSourceAmps(r, "g2ev")), SOLUTION_COLORS.g2ev, "ev"),
    dsBar("Solar", rows.map(r => toSourceAmps(r, "pv2ev")), SOLUTION_COLORS.pv2ev, "ev"),
    dsBar("Battery", rows.map(r => toSourceAmps(r, "b2ev")), SOLUTION_COLORS.b2ev, "ev"),
    {
      label: "Price",
      data: rows.map(r => r.ic ?? 0),
      type: "line",
      yAxisID: "y2",
      borderColor: "rgba(251, 191, 36, 0.5)",
      backgroundColor: "transparent",
      borderWidth: 1.5,
      borderDash: [3, 3],
      pointRadius: 0,
      tension: 0.3,
      order: 0,
    },
  ];

  const evTooltip = createTooltipHandler({
    renderContent: (idx, tooltip) => {
      const time = tooltip.title?.[0] ?? "";
      const row = rows[idx];
      const sources = [
        { key: "g2ev", color: SOLUTION_COLORS.g2ev, label: "Grid" },
        { key: "pv2ev", color: SOLUTION_COLORS.pv2ev, label: "Solar" },
        { key: "b2ev", color: SOLUTION_COLORS.b2ev, label: "Battery" },
      ].filter(s => toSourceAmps(row, s.key) > 0);

      let html = ttHeader(time);
      if (sources.length) {
        html += ttSection(`Charging — ${(row.ev_charge_A || 0).toFixed(1)} A total`);
        for (const s of sources) {
          html += ttRow(s.color, s.label, `${toSourceAmps(row, s.key).toFixed(1)} A`);
        }
      }
      html += ttDivider();
      html += ttPrices(`${(row.ic ?? 0).toFixed(1)}¢`);
      return html;
    },
  });

  const options = getBaseOptions({ ...axis, yTitle: "A", stacked: true }, {
    ...getChartAnimations('bar', rows.length),
    plugins: {
      tooltip: {
        mode: "index",
        intersect: false,
        enabled: false,
        external: evTooltip,
        callbacks: { title: axis.tooltipTitleCb },
      },
    },
  });
  options.scales.y2 = {
    type: "linear",
    position: "right",
    beginAtZero: false,
    ticks: {
      color: "rgba(251, 191, 36, 0.65)",
      font: { size: 10 },
      callback: (v) => `${v.toFixed(0)}¢`,
      maxTicksLimit: 4,
    },
    grid: { drawOnChartArea: false, color: theme.gridColor },
    title: { display: false },
  };

  const depPlugin = makeEvDeparturePlugin(rows, evSettings.departureTime);

  renderChart(canvas, {
    type: "bar",
    data: { labels: axis.labels, datasets },
    options,
    plugins: depPlugin ? [depPlugin] : [],
  });
}

export function drawEvSocChartTab(canvas, rows, evSettings = {}) {
  const timestampsMs = rows.map(r => r.timestampMs);
  const axis = buildTimeAxisFromTimestamps(timestampsMs);

  const { departureTime, targetSoc_percent } = evSettings;
  const targetPlugin = makeEvTargetPlugin(rows, departureTime, targetSoc_percent);
  const plugins = targetPlugin ? [targetPlugin] : [];

  renderChart(canvas, {
    type: "line",
    data: {
      labels: axis.labels,
      datasets: [{
        label: "EV SoC (%)",
        data: rows.map(r => r.ev_soc_percent ?? 0),
        borderColor: SOLUTION_COLORS.ev_charge,
        backgroundColor: SOLUTION_COLORS.ev_charge,
        borderWidth: 2,
        tension: 0.2,
        pointRadius: 0,
        hoverBorderColor: dim(SOLUTION_COLORS.ev_charge),
        clip: false,
      }]
    },
    options: getBaseOptions({ ...axis, yTitle: "%" }, {
      ...getChartAnimations('line', rows.length),
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: "index",
          intersect: false,
          enabled: false,
          external: createTooltipHandler({
            renderContent: (_idx, tooltip) => {
              const time = tooltip.title?.[0] ?? "";
              const pt = tooltip.dataPoints?.[0];
              let html = ttHeader(time);
              if (pt) html += ttRow(SOLUTION_COLORS.ev_charge, "EV SoC", `${Math.round(pt.raw)}%`);
              return html;
            },
          }),
          callbacks: { title: axis.tooltipTitleCb },
        },
      },
      layout: { padding: { bottom: 0 } },
      scales: { y: { min: 0, max: 100 } },
    }),
    plugins,
  });
}

function findDepartureSlotIdx(rows, departureTime) {
  if (!departureTime) return -1;
  const depMs = new Date(departureTime).getTime();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].timestampMs >= depMs) return i;
  }
  return -1;
}

function makeEvDeparturePlugin(rows, departureTime) {
  const depIdx = findDepartureSlotIdx(rows, departureTime);
  if (depIdx < 0) return null;

  const color = 'rgba(16, 185, 129, 0.75)';
  const label = fmtHHMM(new Date(departureTime));

  return {
    id: 'evDeparture',
    afterDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea) return;
      const xPx = scales.x.getPixelForValue(depIdx);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(xPx, chartArea.top);
      ctx.lineTo(xPx, chartArea.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.font = '500 10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(label, xPx, chartArea.top + 10);
      ctx.restore();
    }
  };
}

function makeEvTargetPlugin(rows, departureTime, targetSoc_percent) {
  if (!departureTime || !(targetSoc_percent > 0)) return null;

  const depIdx = findDepartureSlotIdx(rows, departureTime);
  const color = 'rgba(16, 185, 129, 0.75)';

  return {
    id: 'evTarget',
    afterDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea) return;
      const { x: xScale, y: yScale } = scales;

      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);

      const yPx = yScale.getPixelForValue(targetSoc_percent);
      ctx.beginPath();
      ctx.moveTo(chartArea.left, yPx);
      ctx.lineTo(chartArea.right, yPx);
      ctx.stroke();

      if (depIdx >= 0) {
        const xPx = xScale.getPixelForValue(depIdx);
        ctx.beginPath();
        ctx.moveTo(xPx, chartArea.top);
        ctx.lineTo(xPx, chartArea.bottom);
        ctx.stroke();
      }

      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.font = '500 10px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(`${targetSoc_percent}%`, chartArea.right - 4, yPx - 4);

      ctx.restore();
    }
  };
}
