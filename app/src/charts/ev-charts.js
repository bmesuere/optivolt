import {
  createTooltipHandler, getChartAnimations,
  ttHeader, ttRow, ttSection, ttDivider, ttPrices,
} from '../chart-tooltip.js';
import { SOLUTION_COLORS, dim } from './colors.js';
import { buildTimeAxisFromTimestamps, dsBar, getBaseOptions, getChartTheme, renderChart } from './core.js';
import { makeEvDeparturePlugin, makeEvTargetPlugin } from './ev-annotations.js';

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
