/* global Chart */

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

function fmtKwh(v) {
  if (v >= 10) return v.toFixed(1);
  if (v >= 1)  return v.toFixed(2);
  return v.toFixed(3);
}

function injectFlowsTooltipStyles() {
  if (document.getElementById("flows-tt-style")) return;
  const s = document.createElement("style");
  s.id = "flows-tt-style";
  s.textContent = `
    .flows-tt {
      position:absolute; pointer-events:none; z-index:10;
      border-radius:8px; padding:10px 12px; font-size:12px;
      font-family:system-ui,sans-serif; min-width:190px;
      box-shadow:0 4px 20px rgba(0,0,0,0.18);
      transition:opacity .1s ease;
      background:#fff; border:1px solid #e2e8f0; color:#1e293b;
    }
    .dark .flows-tt {
      background:#1e293b; border-color:rgba(255,255,255,0.10); color:#e2e8f0;
      box-shadow:0 4px 20px rgba(0,0,0,0.35);
    }
    .flows-tt-head { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:7px; }
    .flows-tt-time { font-weight:700; font-size:13px; color:#64748b; letter-spacing:.03em; }
    .dark .flows-tt-time { color:#94a3b8; }
    .flows-tt-soc { font-size:11px; color:#64748b; }
    .dark .flows-tt-soc { color:#94a3b8; }
    .flows-tt-soc strong { color:#3b82f6; }
    .dark .flows-tt-soc strong { color:#93c5fd; }
    .flows-tt-sec { font-size:10px; text-transform:uppercase; letter-spacing:.08em;
                    font-weight:600; margin:4px 0 2px; color:#94a3b8; }
    .dark .flows-tt-sec { color:#64748b; }
    .flows-tt-row { display:flex; justify-content:space-between; align-items:center;
                    gap:10px; padding:1.5px 0; }
    .flows-tt-lbl { display:flex; align-items:center; gap:5px; color:#475569; }
    .dark .flows-tt-lbl { color:#cbd5e1; }
    .flows-tt-dot { width:8px; height:8px; border-radius:2px; flex-shrink:0; }
    .flows-tt-val { font-variant-numeric:tabular-nums; font-weight:500; color:#0f172a; }
    .dark .flows-tt-val { color:#f1f5f9; }
    .flows-tt-div { border-top:1px solid #e2e8f0; margin:5px 0; }
    .dark .flows-tt-div { border-color:rgba(255,255,255,0.08); }
    .flows-tt-prices { display:flex; justify-content:space-between; align-items:center;
                       font-size:11px; color:#64748b; padding:1px 0; }
    .dark .flows-tt-prices { color:#94a3b8; }
    .flows-tt-badge { display:inline-block; padding:1px 5px; border-radius:4px;
                      font-size:10px; font-weight:600; letter-spacing:.04em; margin-left:3px; }
    .flows-tt-buy  { background:rgba(239,68,68,0.15); color:#dc2626; }
    .flows-tt-sell { background:rgba(34,197,94,0.15); color:#16a34a; }
    .dark .flows-tt-buy  { background:rgba(239,68,68,0.2); color:#fca5a5; }
    .dark .flows-tt-sell { background:rgba(34,197,94,0.2); color:#86efac; }
  `;
  document.head.appendChild(s);
}

function makeFlowsTooltip(rows, flowSpecs, h) {
  const W2kWh = (x) => (x || 0) * h / 1000;
  injectFlowsTooltipStyles();
  let el = null;

  return function({ chart, tooltip }) {
    if (!el) {
      el = document.createElement("div");
      el.className = "flows-tt";
      chart.canvas.parentNode.style.position = "relative";
      chart.canvas.parentNode.appendChild(el);
    }

    if (tooltip.opacity === 0) { el.style.opacity = "0"; return; }

    const idx = tooltip.dataPoints?.[0]?.dataIndex;
    if (idx == null) return;

    const row = rows[idx];
    const time = tooltip.title?.[0] ?? "";

    const posRows = flowSpecs.filter(s => s.sign === 1  && (row[s.key] || 0) !== 0);
    const negRows = flowSpecs.filter(s => s.sign === -1 && (row[s.key] || 0) !== 0);

    let html = `
      <div class="flows-tt-head">
        <span class="flows-tt-time">${time}</span>
        <span class="flows-tt-soc">SoC <strong>${Math.round(row.soc_percent)}%</strong></span>
      </div>`;

    if (posRows.length) {
      html += `<div class="flows-tt-sec">↑ Sources</div>`;
      for (const s of posRows) {
        html += `<div class="flows-tt-row">
          <span class="flows-tt-lbl"><span class="flows-tt-dot" style="background:${s.color}"></span>${FLOWS_TOOLTIP_LABELS[s.key] ?? s.label}</span>
          <span class="flows-tt-val">${fmtKwh(W2kWh(row[s.key]))}</span>
        </div>`;
      }
    }

    if (posRows.length && negRows.length) html += `<div class="flows-tt-div"></div>`;

    if (negRows.length) {
      html += `<div class="flows-tt-sec">↓ Draws</div>`;
      for (const s of negRows) {
        html += `<div class="flows-tt-row">
          <span class="flows-tt-lbl"><span class="flows-tt-dot" style="background:${s.color}"></span>${FLOWS_TOOLTIP_LABELS[s.key] ?? s.label}</span>
          <span class="flows-tt-val">${fmtKwh(W2kWh(row[s.key]))}</span>
        </div>`;
      }
    }

    html += `<div class="flows-tt-div"></div>
      <div class="flows-tt-prices">
        <span>Buy / Sell</span>
        <span>
          <span class="flows-tt-badge flows-tt-buy">${row.ic.toFixed(1)}¢</span>
          <span class="flows-tt-badge flows-tt-sell">${row.ec.toFixed(1)}¢</span>
        </span>
      </div>`;

    el.innerHTML = html;
    el.style.opacity = "1";

    // Position: beside caret, flip left if it would overflow
    const ttW = el.offsetWidth || 200;
    const ttH = el.offsetHeight || 150;
    const cW  = chart.canvas.offsetWidth;
    let x = tooltip.caretX + 12;
    if (x + ttW > cW - 8) x = tooltip.caretX - ttW - 12;
    let y = tooltip.caretY - ttH / 2;
    if (y < 0) y = 0;
    el.style.left = `${x}px`;
    el.style.top  = `${y}px`;
  };
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
      if (isMidnight(dt)) return "rgba(0,0,0,0.25)";
      if (isLabeledHour(dt) && isFullMinute(dt)) return "rgba(0,0,0,0.08)";
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

// ---------------------- Chart Configuration Helpers ----------------------

/**
 * Generates the standard Chart.js options object used by all 4 charts.
 * Allows overriding specific sections via `overrides`.
 */
export function getBaseOptions({ ticksCb, tooltipTitleCb, gridCb, yTitle, stacked = false }, overrides = {}) {
  const theme = getChartTheme();

  const legendSquare = {
    position: "bottom",
    labels: {
      color: theme.axisTickColor,
      usePointStyle: true,
      pointStyle: "rect",
      boxWidth: 10,
      padding: 12,
      font: (_ctx) => ({
        size: 12,
        family: getComputedStyle(document.documentElement).fontFamily
      })
    }
  };

  // Deep merge for plugins/scales is often needed, but simple spread works for this specific file structure
  const options = {
    maintainAspectRatio: false,
    responsive: true,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: legendSquare, // default, can be overridden
      tooltip: {
        mode: "index",
        intersect: false,
        callbacks: { title: tooltipTitleCb }
      },
      ...overrides.plugins
    },
    scales: {
      x: {
        stacked,
        ticks: {
          color: theme.axisTickColor,
          callback: ticksCb,
          autoSkip: false,
          maxRotation: 0,
          minRotation: 0
        },
        grid: { color: gridCb, drawTicks: true }
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
        title: { display: !!yTitle, text: yTitle },
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
    };
  }
  return {
    axisTickColor: 'rgba(71, 85, 105, 0.95)',       // slate-600-ish
    gridColor: 'rgba(148, 163, 184, 0.22)',         // light grey grid
    zeroLineColor: 'rgba(148, 163, 184, 0.6)',
  };
}

/**
 * Handles the destruction of old chart instances and creation of new ones.
 */
export function renderChart(canvas, config) {
  if (canvas._chart) canvas._chart.destroy();
  canvas._chart = new Chart(canvas.getContext("2d"), config);
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
    { key: "pv2l", color: SOLUTION_COLORS.pv2l, label: "Solar to Consumption", sign: 1 },
    { key: "pv2ev", color: SOLUTION_COLORS.pv2ev, label: "Solar to EV", sign: 1 },
    { key: "pv2b", color: SOLUTION_COLORS.pv2b, label: "Solar to Battery", sign: 1 },
    { key: "pv2g", color: SOLUTION_COLORS.pv2g, label: "Solar to Grid", sign: 1 },
    { key: "b2g", color: SOLUTION_COLORS.b2g, label: "Battery to Grid", sign: 1 },
    // Negative Stack
    { key: "b2l", color: SOLUTION_COLORS.b2l, label: "Battery to Consumption", sign: -1 },
    { key: "b2ev", color: SOLUTION_COLORS.b2ev, label: "Battery to EV", sign: -1 },
    { key: "g2l", color: SOLUTION_COLORS.g2l, label: "Grid to Consumption", sign: -1 },
    { key: "g2ev", color: SOLUTION_COLORS.g2ev, label: "Grid to EV", sign: -1 },
    { key: "g2b", color: SOLUTION_COLORS.g2b, label: "Grid to Battery", sign: -1 },
  ];

  const specKeys = new Set(flowSpecs.map(s => s.key));
  const nonZeroKeys = new Set();
  for (const r of rows) for (const k of specKeys) if ((r[k] || 0) !== 0) nonZeroKeys.add(k);
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
  const depPlugin = evSettings?.departureTime
    ? makeEvDeparturePlugin(rows, evSettings.departureTime)
    : null;
  if (depPlugin) plugins.push(depPlugin);

  renderChart(canvas, {
    type: "bar",
    data: { labels: axis.labels, datasets },
    options: getBaseOptions({ ...axis, yTitle: "kWh", stacked: true }, {
      plugins: {
        tooltip: {
          mode: "index",
          intersect: false,
          enabled: false,
          external: makeFlowsTooltip(rows, flowSpecs, h),
          callbacks: { title: axis.tooltipTitleCb },
        }
      }
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

  const datasets = [{
    label: "Battery SoC (%)",
    data: rows.map(r => r.soc_percent),
    borderColor: SOLUTION_COLORS.soc,
    backgroundColor: SOLUTION_COLORS.soc,
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
      backgroundColor: SOLUTION_COLORS.ev_charge,
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
      plugins: hasEvSoc ? {} : { legend: { display: false } },
      scales: { y: { max: 100 } }
    }),
    plugins: evTargetPlugin ? [evTargetPlugin] : [],
  });
}

// -----------------------------------------------------------------------------
// 3) Buy/Sell price chart (stepped line)
// -----------------------------------------------------------------------------

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
    options: getBaseOptions({ ...axis, yTitle: "c€/kWh" })
  });
}

// -----------------------------------------------------------------------------
// 4) Forecast grouped bars (hourly aggregation)
// -----------------------------------------------------------------------------

export function drawLoadPvGrouped(canvas, rows, stepSize_m = 15) {
  const stepHours = Math.max(0.000001, Number(stepSize_m) / 60);
  const W2kWh = (x) => (x || 0) * stepHours / 1000;

  // Aggregate 15min slots into hourly buckets
  const hourMap = new Map();

  for (const row of rows) {
    const dt = new Date(row.timestampMs);
    dt.setMinutes(0, 0, 0); // Round to start of hour
    const hourMs = dt.getTime();

    if (!hourMap.has(hourMs)) {
      hourMap.set(hourMs, { dtHour: dt, loadKWh: 0, pvKWh: 0 });
    }
    const bucket = hourMap.get(hourMs);
    bucket.loadKWh += W2kWh(row.load);
    bucket.pvKWh += W2kWh(row.pv);
  }

  const buckets = [...hourMap.values()].sort((a, b) => a.dtHour - b.dtHour);

  // Build axis based on aggregated timestamps
  const axis = buildTimeAxisFromTimestamps(buckets.map(b => b.dtHour.getTime()));

  const stripe = (c) => window.pattern?.draw("diagonal", c) || c;
  const ds = (label, data, color) => ({
    label, data,
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
        ds("Consumption forecast", buckets.map(b => b.loadKWh), SOLUTION_COLORS.g2l),
        ds("Solar forecast", buckets.map(b => b.pvKWh), SOLUTION_COLORS.pv2g)
      ]
    },
    options: getBaseOptions({ ...axis, yTitle: "kWh" })
  });
}

// -----------------------------------------------------------------------------
// EV tab charts
// -----------------------------------------------------------------------------

export function drawEvPowerChart(canvas, rows, stepSize_m = 15, evSettings = {}) {
  const timestampsMs = rows.map(r => r.timestampMs);
  const axis = buildTimeAxisFromTimestamps(timestampsMs);

  const h = Math.max(0.000001, Number(stepSize_m) / 60);
  const W2kWh = (x) => (x || 0) * h / 1000;
  const theme = getChartTheme();

  const datasets = [
    dsBar("Grid", rows.map(r => W2kWh(r.g2ev)), SOLUTION_COLORS.g2ev, "ev"),
    dsBar("Solar", rows.map(r => W2kWh(r.pv2ev)), SOLUTION_COLORS.pv2ev, "ev"),
    dsBar("Battery", rows.map(r => W2kWh(r.b2ev)), SOLUTION_COLORS.b2ev, "ev"),
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

  const options = getBaseOptions({ ...axis, yTitle: "kWh", stacked: true });
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
      plugins: { legend: { display: false } },
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
    afterDraw(chart) {
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
    afterDraw(chart) {
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
