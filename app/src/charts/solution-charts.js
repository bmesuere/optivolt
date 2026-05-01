import {
  createTooltipHandler, fmtKwh, getChartAnimations,
  ttHeader, ttRow, ttSection, ttDivider, ttPrices,
} from '../chart-tooltip.js';
import { SOLUTION_COLORS, dim, toRGBA } from './colors.js';
import { buildTimeAxisFromTimestamps, dsBar, getBaseOptions, getChartTheme, renderChart } from './core.js';
import { makeEvDeparturePlugin, makeEvTargetPlugin } from './ev-annotations.js';
import {
  BUY_PRICE_STRIP_TICK_PADDING,
  makeBuyPriceStripPlugin,
  makeNegativePriceInjectionPlugin,
  makeRebalancingPlugin,
} from './overlays.js';

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

export function drawFlowsBarStackSigned(canvas, rows, stepSize_m = 15, rebalanceWindow = null, evSettings = null) {
  const timestampsMs = rows.map(r => r.timestampMs);
  const axis = buildTimeAxisFromTimestamps(timestampsMs);

  const h = Math.max(0.000001, Number(stepSize_m) / 60);
  const W2kWh = (x) => (x || 0) * h / 1000;

  const stackId = "flows";

  const flowSpecs = [
    { key: "pv2l",  color: SOLUTION_COLORS.pv2l,  label: "Solar → Load",     sign: 1 },
    { key: "pv2ev", color: SOLUTION_COLORS.pv2ev, label: "Solar → EV",       sign: 1 },
    { key: "pv2b",  color: SOLUTION_COLORS.pv2b,  label: "Solar → Battery",  sign: 1 },
    { key: "pv2g",  color: SOLUTION_COLORS.pv2g,  label: "Solar → Grid",     sign: 1 },
    { key: "b2g",   color: SOLUTION_COLORS.b2g,   label: "Battery → Grid",   sign: 1 },
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
    dt.setMinutes(0, 0, 0);
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

export function drawLoadPvGrouped(canvas, rows, stepSize_m = 15) {
  const buckets = aggregateLoadPvBuckets(rows, stepSize_m);
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
