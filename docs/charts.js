// charts.js

const SOLUTION_COLORS = {
  b2g: "rgb(15, 192, 216)",   // Battery to Grid (teal-ish)
  pv2g: "rgb(247, 171, 62)",  // Solar to Grid (amber)
  pv2b: "rgb(139, 201, 100)", // Solar to Battery (green)
  pv2l: "rgb(212, 222, 95)",  // Solar to Consumption (yellow-green)
  b2l: "rgb(71, 144, 208)",   // Battery to Consumption (blue)
  g2l: "rgb(233, 122, 131)",  // Grid to Consumption (red)
  g2b: "rgb(225, 142, 233)",  // Grid to Battery (purple)
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
    font: (ctx) => ({
      size: 12,
      family: getComputedStyle(document.documentElement).fontFamily
    })
  }
};

// ---- time formatting helpers ----

function fmtHHMM(dt) {
  const HH = String(dt.getHours()).padStart(2, "0");
  const MM = String(dt.getMinutes()).padStart(2, "0");
  return `${HH}:${MM}`;
}

// For tick text on axis: show only hours, and at midnight show DD/MM.
function fmtTickHourOrDate(dt) {
  const mins = dt.getMinutes();
  if (mins !== 0) return ""; // hide :15/:30/:45

  const hrs = dt.getHours();
  if (hrs === 0) {
    const dd = String(dt.getDate()).padStart(2, "0");
    const mm = String(dt.getMonth() + 1).padStart(2, "0");
    return `${dd}/${mm}`;
  }

  return `${String(hrs).padStart(2, "0")}:00`;
}

function isAnchorTick(dt) {
  return dt.getMinutes() === 0;
}

/**
 * Build the time axis helpers given an explicit timestamps array.
 * timestampsMs: [msSinceEpoch0, msSinceEpoch1, ...]
 *
 * Returns:
 * - labels: ["HH:MM", ...] (one per slot, always full HH:MM; used as category labels)
 * - ticksCb(index): draws either "", "HH:00", or "DD/MM" depending on slot
 * - tooltipTitleCb(items): always "HH:MM" for hovered slot
 * - gridCb(ctx): "transparent" except on hour boundaries (inc. midnight)
 */
function buildTimeAxisFromTimestamps(timestampsMs) {
  const times = timestampsMs.map(ms => new Date(ms));

  const labels = times.map(dt => fmtHHMM(dt));

  function ticksCb(value, index) {
    const dt = times[index];
    if (!dt) return "";
    return fmtTickHourOrDate(dt);
  }

  function tooltipTitleCb(items) {
    if (!items || !items.length) return "";
    const idx = items[0].dataIndex;
    const dt = times[idx];
    if (!dt) return "";
    return fmtHHMM(dt);
  }

  function gridCb(ctx) {
    // Chart.js sometimes calls us with weird contexts; be defensive
    let idx = ctx.index;
    if (idx == null && ctx.tick && ctx.tick.index != null) {
      idx = ctx.tick.index;
    }
    if (idx == null && ctx.tick && ctx.tick.value != null) {
      idx = ctx.tick.value;
    }
    if (idx == null) return "transparent";

    const dt = times[idx];
    if (!dt) return "transparent";

    return isAnchorTick(dt) ? undefined : "transparent";
  }

  return { labels, ticksCb, tooltipTitleCb, gridCb };
}

// ---- small helper for stacked bars ----

function dsBar(label, data, color, stack) {
  return {
    label,
    data,
    stack,
    type: "bar",
    backgroundColor: color,
    hoverBackgroundColor: dim(color),
    borderColor: color,
    borderWidth: 0.5
  };
}

// -----------------------------------------------------------------------------
// 1) Power flows stacked bar (signed kWh)
// -----------------------------------------------------------------------------

// rows: [{... flows ...}], stepSize_m: minutes per slot (for W→kWh)
// timestampsMs: array of ms timestamps aligned with rows
export function drawFlowsBarStackSigned(canvas, rows, stepSize_m = 15, timestampsMs = []) {
  const { labels, ticksCb, tooltipTitleCb, gridCb } =
    buildTimeAxisFromTimestamps(timestampsMs);

  const h = Math.max(0.000001, Number(stepSize_m) / 60);
  const W2kWh = (x) => (x || 0) * h / 1000;

  const posOrder = [
    { key: "pv2l", color: SOLUTION_COLORS.pv2l, label: "Solar to Consumption" },
    { key: "pv2b", color: SOLUTION_COLORS.pv2b, label: "Solar to Battery" },
    { key: "pv2g", color: SOLUTION_COLORS.pv2g, label: "Solar to Grid" },
    { key: "b2g", color: SOLUTION_COLORS.b2g, label: "Battery to Grid" }
  ];

  const negOrder = [
    { key: "b2l", color: SOLUTION_COLORS.b2l, label: "Battery to Consumption" },
    { key: "g2l", color: SOLUTION_COLORS.g2l, label: "Grid to Consumption" },
    { key: "g2b", color: SOLUTION_COLORS.g2b, label: "Grid to Battery" }
  ];

  const stackId = "flows";
  const datasets = [];

  for (const spec of posOrder) {
    datasets.push(
      dsBar(
        spec.label,
        rows.map(r => +Math.abs(W2kWh(r[spec.key]))),
        spec.color,
        stackId
      )
    );
  }

  for (const spec of negOrder) {
    datasets.push(
      dsBar(
        spec.label,
        rows.map(r => -Math.abs(W2kWh(r[spec.key]))),
        spec.color,
        stackId
      )
    );
  }

  if (canvas._chart) canvas._chart.destroy();
  canvas._chart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: { labels, datasets },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: legendSquare,
        tooltip: {
          mode: "index",
          intersect: false,
          callbacks: { title: tooltipTitleCb }
        }
      },
      scales: {
        x: {
          stacked: true,
          ticks: {
            callback: ticksCb,
            autoSkip: false,
            maxRotation: 0,
            minRotation: 0
          },
          grid: {
            color: gridCb,
            drawTicks: true
          }
        },
        y: {
          stacked: true,
          title: { display: true, text: "kWh" }
        }
      }
    }
  });
}

// -----------------------------------------------------------------------------
// 2) SoC line chart (%)
// -----------------------------------------------------------------------------

export function drawSocChart(canvas, rows, batteryCapacity_Wh = 20480, stepSize_m = 15, timestampsMs = []) {
  const { labels, ticksCb, tooltipTitleCb, gridCb } =
    buildTimeAxisFromTimestamps(timestampsMs);

  const cap = Math.max(1e-9, Number(batteryCapacity_Wh));
  const socPct = rows.map(r => (r.soc / cap) * 100);

  if (canvas._chart) canvas._chart.destroy();
  canvas._chart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "SoC (%)",
        data: socPct,
        borderColor: SOLUTION_COLORS.soc,
        backgroundColor: toRGBA(SOLUTION_COLORS.soc, 0.12),
        borderWidth: 2,
        tension: 0.2,
        pointRadius: 0,
        hoverBorderColor: dim(SOLUTION_COLORS.soc)
      }]
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: "index",
          intersect: false,
          callbacks: { title: tooltipTitleCb }
        }
      },
      scales: {
        x: {
          ticks: {
            callback: ticksCb,
            autoSkip: false,
            maxRotation: 0,
            minRotation: 0
          },
          grid: {
            color: gridCb,
            drawTicks: true
          }
        },
        y: {
          beginAtZero: true,
          max: 100,
          title: { display: true, text: "%" }
        }
      }
    }
  });
}

// -----------------------------------------------------------------------------
// 3) Buy/Sell price chart (stepped line)
// -----------------------------------------------------------------------------

export function drawPricesStepLines(canvas, rows, stepSize_m = 15, timestampsMs = []) {
  const { labels, ticksCb, tooltipTitleCb, gridCb } =
    buildTimeAxisFromTimestamps(timestampsMs);

  if (canvas._chart) canvas._chart.destroy();
  canvas._chart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Buy price",
          data: rows.map(r => r.ic),
          stepped: true,
          borderColor: "#ef4444",
          pointRadius: 0,
          pointHitRadius: 8
        },
        {
          label: "Sell price",
          data: rows.map(r => r.ec),
          stepped: true,
          borderColor: "#22c55e",
          pointRadius: 0,
          pointHitRadius: 8
        }
      ]
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: legendSquare,
        tooltip: {
          mode: "index",
          intersect: false,
          callbacks: { title: tooltipTitleCb }
        }
      },
      scales: {
        x: {
          ticks: {
            callback: ticksCb,
            autoSkip: false,
            maxRotation: 0,
            minRotation: 0
          },
          grid: {
            color: gridCb,
            drawTicks: true
          }
        },
        y: {
          beginAtZero: true,
          title: { display: true, text: "c€/kWh" }
        }
      }
    }
  });
}

// -----------------------------------------------------------------------------
// 4) Forecast grouped bars (kWh) with stripes
// -----------------------------------------------------------------------------

export function drawLoadPvGrouped(canvas, rows, stepSize_m = 15, timestampsMs = []) {
  const { labels, ticksCb, tooltipTitleCb, gridCb } =
    buildTimeAxisFromTimestamps(timestampsMs);

  const h = Math.max(0.000001, Number(stepSize_m) / 60);
  const W2kWh = (x) => (x || 0) * h / 1000;

  const red = SOLUTION_COLORS.g2l;   // consumption forecast color
  const amber = SOLUTION_COLORS.pv2g;  // solar forecast color

  const stripe = (color) => window.pattern?.draw("diagonal", color) || color;

  if (canvas._chart) canvas._chart.destroy();
  canvas._chart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Consumption forecast",
          data: rows.map(r => W2kWh(r.load)),
          backgroundColor: stripe(red),
          borderColor: red,
          borderWidth: 1,
          hoverBackgroundColor: stripe(dim(red))
        },
        {
          label: "Solar forecast",
          data: rows.map(r => W2kWh(r.pv)),
          backgroundColor: stripe(amber),
          borderColor: amber,
          borderWidth: 1,
          hoverBackgroundColor: stripe(dim(amber))
        }
      ]
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: legendSquare,
        tooltip: {
          mode: "index",
          intersect: false,
          callbacks: { title: tooltipTitleCb }
        }
      },
      scales: {
        x: {
          stacked: false,
          ticks: {
            callback: ticksCb,
            autoSkip: false,
            maxRotation: 0,
            minRotation: 0
          },
          grid: {
            color: gridCb,
            drawTicks: true
          }
        },
        y: {
          beginAtZero: true,
          title: { display: true, text: "kWh" }
        }
      }
    }
  });
}
