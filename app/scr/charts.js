/* global Chart */

export const SOLUTION_COLORS = {
  b2g: "rgb(15, 192, 216)",   // Battery to Grid (teal-ish)
  pv2g: "rgb(247, 171, 62)",  // Solar to Grid (amber)
  pv2b: "rgb(139, 201, 100)", // Solar to Battery (green)
  pv2l: "rgb(212, 222, 95)",  // Solar to Consumption (yellow-green)
  b2l: "rgb(71, 144, 208)",   // Battery to Consumption (blue)
  g2l: "rgb(233, 122, 131)",  // Grid to Consumption (red)
  g2b: "rgb(225, 142, 233)",  // Grid to Battery (purple)
  soc: "rgb(71, 144, 208)"    // SoC line color = battery-ish blue
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

// ---------------------- time formatting helpers ----------------------

function fmtHHMM(dt) {
  const HH = String(dt.getHours()).padStart(2, "0");
  const MM = String(dt.getMinutes()).padStart(2, "0");
  return `${HH}:${MM}`;
}

// On the axis: at midnight, show "DD/MM". Otherwise "HH:00".
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

/**
 * Build x-axis helpers shared by all charts.
 *
 * Input: timestampsMs[] for each plotted data point (slot or bucket).
 *
 * Output:
 *   labels[]:     human-ish fallback labels (HH:MM per point, used internally)
 *   ticksCb():    axis tick formatter (decides which ticks get text)
 *   tooltipTitleCb(): tooltip title (HH:MM precise)
 *   gridCb():     grid line color per tick (midnight emphasized)
 *
 * This function also does dynamic thinning:
 * - If total span <= 12h, label *every* hour tick.
 * - If span > 12h, label only midnight and every 3rd hour.
 */
function buildTimeAxisFromTimestamps(timestampsMs) {
  const times = timestampsMs.map(ms => new Date(ms));

  // rough horizon size in hours
  let hoursSpan = 0;
  if (times.length > 1) {
    const spanMs = times[times.length - 1] - times[0];
    hoursSpan = spanMs / (60 * 60 * 1000);
  }

  const sparseMode = hoursSpan > 12;
  const labelEveryH = 3; // in sparse mode, show 0:00, 3:00, 6:00, 9:00, ...

  function isFullMinute(dt) {
    return dt.getMinutes() === 0;
  }

  function isMidnight(dt) {
    return dt.getHours() === 0 && dt.getMinutes() === 0;
  }

  function isLabeledHour(dt) {
    // Always show midnight
    if (isMidnight(dt)) return true;
    if (!isFullMinute(dt)) return false;

    if (!sparseMode) {
      // Dense mode: label every hour
      return true;
    }
    // Sparse mode: only every 3 hours
    return (dt.getHours() % labelEveryH) === 0;
  }

  // labels array: HH:MM for each point
  const labels = times.map(dt => fmtHHMM(dt));

  // Tick labels for the axis
  function ticksCb(value, index) {
    const dt = times[index];
    if (!dt) return "";
    if (!isLabeledHour(dt)) return "";
    return fmtTickHourOrDate(dt);
  }

  // Tooltip title always shows true HH:MM for that exact point
  function tooltipTitleCb(items) {
    if (!items || !items.length) return "";
    const idx = items[0].dataIndex;
    const dt = times[idx];
    if (!dt) return "";
    return fmtHHMM(dt);
  }

  // Grid line color per tick index
  // We want:
  // - A visible/darker line at midnight.
  // - A lighter vertical line at other labeled hour ticks (3:00, 6:00, 9:00, etc.).
  // - Transparent everywhere else.
  function gridCb(ctx) {
    // Chart.js callback contexts are... creative.
    let idx = ctx.index;
    if (idx == null && ctx.tick && ctx.tick.index != null) idx = ctx.tick.index;
    if (idx == null && ctx.tick && ctx.tick.value != null) idx = ctx.tick.value;
    if (idx == null) return "transparent";

    const dt = times[idx];
    if (!dt) return "transparent";

    if (isMidnight(dt)) {
      // Stronger line at midnight
      return "rgba(0,0,0,0.25)";
    }

    if (isLabeledHour(dt) && isFullMinute(dt)) {
      return "rgba(0,0,0,0.08)";
    }

    return "transparent";
  }

  return { labels, ticksCb, tooltipTitleCb, gridCb };
}

// simple helper for signed stacked bars
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
// 1) Power flows bar chart (signed kWh, stacked)
// -----------------------------------------------------------------------------

export function drawFlowsBarStackSigned(canvas, rows, stepSize_m = 15) {
  const timestampsMs = rows.map(r => r.timestampMs);

  const { labels, ticksCb, tooltipTitleCb, gridCb } =
    buildTimeAxisFromTimestamps(timestampsMs);

  const h = Math.max(0.000001, Number(stepSize_m) / 60);
  const W2kWh = (x) => (x || 0) * h / 1000;

  // Order stacks so closest-to-axis = most "local" flows
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

export function drawSocChart(canvas, rows, batteryCapacity_Wh = 20480, _stepSize_m = 15) {
  const timestampsMs = rows.map(r => r.timestampMs);
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
        backgroundColor: SOLUTION_COLORS.soc,
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

export function drawPricesStepLines(canvas, rows, _stepSize_m = 15) {
  const timestampsMs = rows.map(r => r.timestampMs);
  const { labels, ticksCb, tooltipTitleCb, gridCb } =
    buildTimeAxisFromTimestamps(timestampsMs);

  // adapt line width based on density
  const N = labels.length;
  const strokeW = (N > 48) ? 1 : 2;

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
          backgroundColor: "#ef4444",
          borderWidth: strokeW,
          pointRadius: 0,
          pointHitRadius: 8
        },
        {
          label: "Sell price",
          data: rows.map(r => r.ec),
          stepped: true,
          borderColor: "#22c55e",
          backgroundColor: "#22c55e",
          borderWidth: strokeW,
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
// 4) Forecast grouped bars (hourly aggregation, shared axis style)
// -----------------------------------------------------------------------------

export function drawLoadPvGrouped(canvas, rows, stepSize_m = 15) {
  // We aggregate 4×15min slots into hourly buckets for display.
  // Internally: convert each slot load/pv from W to kWh, then SUM per hour.

  const stepHours = Math.max(0.000001, Number(stepSize_m) / 60);
  const W2kWh = (x) => (x || 0) * stepHours / 1000;

  // Group by local hour
  // Key is millis for that hour start (local time),
  // Value accumulates loadKWh and pvKWh for that hour.
  const hourMap = new Map();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const ms = row.timestampMs;
    const dt = new Date(ms);
    const hourStartLocal = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), dt.getHours(), 0, 0, 0);
    const hourMs = hourStartLocal.getTime();

    if (!hourMap.has(hourMs)) {
      hourMap.set(hourMs, {
        dtHour: hourStartLocal,
        loadKWh: 0,
        pvKWh: 0
      });
    }
    const bucket = hourMap.get(hourMs);
    bucket.loadKWh += W2kWh(rows[i].load);
    bucket.pvKWh += W2kWh(rows[i].pv);
  }

  // Sort buckets chronologically
  const bucketsSorted = [...hourMap.values()].sort((a, b) => a.dtHour - b.dtHour);

  // Rebuild timestamps for the bucketed series from each hour start.
  // We'll feed these hour-start timestamps into buildTimeAxisFromTimestamps
  const bucketTimestampsMs = bucketsSorted.map(b => b.dtHour.getTime());

  // Axis/ticks/grid use the same logic now:
  const { labels, ticksCb, tooltipTitleCb, gridCb } =
    buildTimeAxisFromTimestamps(bucketTimestampsMs);

  // Data arrays for the bars
  const loadData = bucketsSorted.map(b => b.loadKWh);
  const pvData = bucketsSorted.map(b => b.pvKWh);

  // Colors: consumption forecast (red-ish), solar forecast (amber)
  const red = SOLUTION_COLORS.g2l;
  const amber = SOLUTION_COLORS.pv2g;
  const stripe = (color) => window.pattern?.draw("diagonal", color) || color;

  if (canvas._chart) canvas._chart.destroy();
  canvas._chart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Consumption forecast",
          data: loadData,
          backgroundColor: stripe(red),
          borderColor: red,
          borderWidth: 1,
          hoverBackgroundColor: stripe(dim(red))
        },
        {
          label: "Solar forecast",
          data: pvData,
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
          callbacks: {
            // use the shared tooltip title (HH:MM)
            title: (items) => tooltipTitleCb(items)
          }
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
