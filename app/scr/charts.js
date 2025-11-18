/* global Chart */

export const SOLUTION_COLORS = {
  b2g: "rgb(15, 192, 216)",
  pv2g: "rgb(247, 171, 62)",
  pv2b: "rgb(139, 201, 100)",
  pv2l: "rgb(212, 222, 95)",
  b2l: "rgb(71, 144, 208)",
  g2l: "rgb(233, 122, 131)",
  g2b: "rgb(225, 142, 233)",
  soc: "rgb(71, 144, 208)"
};

const toRGBA = (rgb, alpha = 1) => {
  const m = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(rgb);
  return m ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})` : rgb;
};
const dim = (rgb) => toRGBA(rgb, 0.6);

const legendSquare = {
  position: "bottom",
  labels: {
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

// ---------------------- Time & Axis Helpers ----------------------

function fmtHHMM(dt) {
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

function buildTimeAxisFromTimestamps(timestampsMs) {
  const times = timestampsMs.map(ms => new Date(ms));
  let hoursSpan = 0;
  if (times.length > 1) {
    hoursSpan = (times[times.length - 1] - times[0]) / (3600 * 1000);
  }

  const sparseMode = hoursSpan > 12;
  const labelEveryH = 3;

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

// ---------------------- Chart Configuration Helpers ----------------------

/**
 * Generates the standard Chart.js options object used by all 4 charts.
 * Allows overriding specific sections via `overrides`.
 */
function getBaseOptions({ ticksCb, tooltipTitleCb, gridCb, yTitle, stacked = false }, overrides = {}) {
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
        title: { display: !!yTitle, text: yTitle },
        // If specific charts need Y overrides (like max: 100), merge them here:
        ...(overrides.scales?.y || {})
      }
    }
  };
  return options;
}

/**
 * Handles the destruction of old chart instances and creation of new ones.
 */
function renderChart(canvas, config) {
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

export function drawFlowsBarStackSigned(canvas, rows, stepSize_m = 15) {
  const timestampsMs = rows.map(r => r.timestampMs);
  const axis = buildTimeAxisFromTimestamps(timestampsMs);

  const h = Math.max(0.000001, Number(stepSize_m) / 60);
  const W2kWh = (x) => (x || 0) * h / 1000;

  const stackId = "flows";

  // Define structure: key -> params
  const flowSpecs = [
    // Positive Stack
    { key: "pv2l", color: SOLUTION_COLORS.pv2l, label: "Solar to Consumption", sign: 1 },
    { key: "pv2b", color: SOLUTION_COLORS.pv2b, label: "Solar to Battery", sign: 1 },
    { key: "pv2g", color: SOLUTION_COLORS.pv2g, label: "Solar to Grid", sign: 1 },
    { key: "b2g", color: SOLUTION_COLORS.b2g, label: "Battery to Grid", sign: 1 },
    // Negative Stack
    { key: "b2l", color: SOLUTION_COLORS.b2l, label: "Battery to Consumption", sign: -1 },
    { key: "g2l", color: SOLUTION_COLORS.g2l, label: "Grid to Consumption", sign: -1 },
    { key: "g2b", color: SOLUTION_COLORS.g2b, label: "Grid to Battery", sign: -1 }
  ];

  const datasets = flowSpecs.map(spec =>
    dsBar(
      spec.label,
      rows.map(r => spec.sign * Math.abs(W2kWh(r[spec.key]))),
      spec.color,
      stackId
    )
  );

  renderChart(canvas, {
    type: "bar",
    data: { labels: axis.labels, datasets },
    options: getBaseOptions({ ...axis, yTitle: "kWh", stacked: true })
  });
}

// -----------------------------------------------------------------------------
// 2) SoC line chart (%)
// -----------------------------------------------------------------------------

export function drawSocChart(canvas, rows, _stepSize_m = 15) {
  const timestampsMs = rows.map(r => r.timestampMs);
  const axis = buildTimeAxisFromTimestamps(timestampsMs);

  renderChart(canvas, {
    type: "line",
    data: {
      labels: axis.labels,
      datasets: [{
        label: "SoC (%)",
        data: rows.map(r => r.soc_percent),
        borderColor: SOLUTION_COLORS.soc,
        backgroundColor: SOLUTION_COLORS.soc,
        borderWidth: 2,
        tension: 0.2,
        pointRadius: 0,
        hoverBorderColor: dim(SOLUTION_COLORS.soc)
      }]
    },
    options: getBaseOptions({ ...axis, yTitle: "%" }, {
      plugins: { legend: { display: false } }, // Hide legend for this chart
      scales: { y: { max: 100 } }
    })
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
