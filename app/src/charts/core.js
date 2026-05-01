/* global Chart */
import { dim } from './colors.js';

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

  const daysSpan = hoursSpan / 24;

  let labelEveryH = 3;
  const sparseMode = hoursSpan > 12;

  if (daysSpan > 2) {
    labelEveryH = 24;
  } else if (hoursSpan > 12) {
    labelEveryH = 4;
  } else {
    labelEveryH = 2;
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
    ticksCb: (_val, idx) => {
      const dt = times[idx];
      return (dt && isLabeledHour(dt)) ? fmtTickHourOrDate(dt) : "";
    },
    tooltipTitleCb: (items) => {
      const idx = items?.[0]?.dataIndex;
      return times[idx] ? fmtHHMM(times[idx]) : "";
    },
    gridCb: (ctx) => {
      const idx = ctx.index ?? ctx.tick?.index ?? ctx.tick?.value;
      if (idx == null || !times[idx]) return "transparent";
      const dt = times[idx];
      const { majorGridColor, minorGridColor } = getChartTheme();
      if (isMidnight(dt)) return majorGridColor;
      if (isLabeledHour(dt) && isFullMinute(dt)) return minorGridColor;
      return "transparent";
    }
  };
}

/**
 * Generates the standard Chart.js options object used by all charts.
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

  return {
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
        ...(overrides.scales?.y || {})
      }
    }
  };
}

export function getChartTheme() {
  const dark = document.documentElement.classList.contains('dark');
  if (dark) {
    return {
      axisTickColor: 'rgba(226, 232, 240, 0.9)',
      gridColor: 'rgba(148, 163, 184, 0.28)',
      zeroLineColor: 'rgba(148, 163, 184, 0.6)',
      majorGridColor: 'rgba(226, 232, 240, 0.32)',
      minorGridColor: 'rgba(226, 232, 240, 0.10)',
    };
  }
  return {
    axisTickColor: 'rgba(71, 85, 105, 0.95)',
    gridColor: 'rgba(148, 163, 184, 0.22)',
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
  // Pick up charts created directly with new Chart(...) outside renderChart (e.g. predictions-validation.js)
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

export const dsBar = (label, data, color, stack) => ({
  label, data, stack,
  type: "bar",
  backgroundColor: color,
  hoverBackgroundColor: dim(color),
  borderColor: color,
  borderWidth: 0.5
});
