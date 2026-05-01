import { buildTimeAxisFromTimestamps, getBaseOptions, renderChart } from '../charts.js';
import { createTooltipHandler, fmtKwh, getChartAnimations, ttHeader, ttRow, ttDivider } from '../chart-tooltip.js';

export function renderLoadAccuracyChart(recentData) {
  renderAccuracyCharts(
    'load-accuracy-chart',
    'load-accuracy-diff-chart',
    'load-daily-net-error',
    recentData,
    {
      actualLabel: 'Actual',
      predLabel: 'Prediction',
      actualColor: 'rgb(14, 165, 233)',
      predColor: 'rgb(249, 115, 22)',
      valueActual: d => d.actual,
      valuePred: d => d.predicted,
    }
  );
}

export function renderPvAccuracyChart(recentData) {
  renderAccuracyCharts(
    'pv-accuracy-chart',
    'pv-accuracy-diff-chart',
    'pv-daily-net-error',
    recentData,
    {
      actualLabel: 'Actual',
      predLabel: 'Predicted',
      actualColor: 'rgb(14, 165, 233)',
      predColor: 'rgb(249, 115, 22)',
      valueActual: d => d.actual ?? 0,
      valuePred: d => d.predicted ?? 0,
    }
  );
}

function buildDayDividersPlugin(timestamps, dayNetWh, netErrorContainerId) {
  const daySpans = new Map();
  for (let i = 0; i < timestamps.length; i++) {
    const dateStr = new Date(timestamps[i]).toLocaleDateString('en-CA');
    if (!daySpans.has(dateStr)) daySpans.set(dateStr, { first: i, last: i });
    else daySpans.get(dateStr).last = i;
  }
  const days = [...daySpans.entries()];
  let lastChartGeometry = null;

  return {
    id: 'dayDividers',
    afterDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!scales.x || !chartArea) return;

      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(148,163,184,0.3)';
      ctx.lineWidth = 1;
      ctx.font = '9px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(148,163,184,0.5)';
      ctx.textAlign = 'center';

      for (let i = 0; i < days.length; i++) {
        const [_dateStr, { first, last }] = days[i];
        if (i > 0) {
          const x = scales.x.getPixelForValue(first);
          ctx.beginPath();
          ctx.moveTo(x, chartArea.top);
          ctx.lineTo(x, chartArea.bottom);
          ctx.stroke();
        }
        const midX = (scales.x.getPixelForValue(first) + scales.x.getPixelForValue(last)) / 2;
        const dayName = new Date(timestamps[first]).toLocaleDateString('en-US', { weekday: 'short' });
        ctx.fillText(dayName, midX, chartArea.top + 10);
      }

      ctx.restore();

      const geometry = `${chartArea.left},${chartArea.right}`;
      if (!netErrorContainerId || !dayNetWh || geometry === lastChartGeometry) return;
      lastChartGeometry = geometry;

      const container = document.getElementById(netErrorContainerId);
      if (!container) return;

      let html = `<div style="position:absolute;top:2px;left:${chartArea.left}px;font-size:9px;font-weight:600;letter-spacing:0.08em;color:rgba(148,163,184,0.45);text-transform:uppercase;">net error (kWh)</div>`;

      for (const [dateStr, { first, last }] of days) {
        const midX = (scales.x.getPixelForValue(first) + scales.x.getPixelForValue(last)) / 2;
        const netKwh = (dayNetWh.get(dateStr) ?? 0) / 1000;
        const color = netKwh >= 0 ? 'rgb(139,201,100)' : 'rgb(233,122,131)';
        const sign = netKwh >= 0 ? '+' : '−';
        html += `<div style="position:absolute;top:16px;left:${midX}px;transform:translateX(-50%);font-size:11px;font-weight:600;color:${color};white-space:nowrap">${sign}${fmtKwh(Math.abs(netKwh))}</div>`;
      }

      container.style.position = 'relative';
      container.style.height = '32px';
      container.innerHTML = html;
      container.classList.remove('hidden');
    },
  };
}

function renderAccuracyCharts(overlayCanvasId, diffCanvasId, netErrorContainerId, recentData, options) {
  const overlayCanvas = document.getElementById(overlayCanvasId);
  const diffCanvas = document.getElementById(diffCanvasId);
  if (!overlayCanvas || !recentData || recentData.length === 0) return;

  const sorted = [...recentData].sort((a, b) => a.time - b.time);
  const axis = buildTimeAxisFromTimestamps(sorted.map(d => d.time));

  const timestamps = sorted.map(d => d.time);

  const dayNetWh = new Map();
  for (const d of sorted) {
    const actual = options.valueActual(d);
    const pred = options.valuePred(d);
    if (actual == null || pred == null) continue;
    const dateStr = new Date(d.time).toLocaleDateString('en-CA');
    dayNetWh.set(dateStr, (dayNetWh.get(dateStr) ?? 0) + (pred - actual));
  }

  const dayDividersPlugin = buildDayDividersPlugin(timestamps, dayNetWh, netErrorContainerId);
  const dayDividersPluginDiff = buildDayDividersPlugin(timestamps, null, null);

  renderChart(overlayCanvas, {
    type: 'line',
    data: {
      labels: axis.labels,
      datasets: [
        {
          label: options.actualLabel,
          data: sorted.map(d => options.valueActual(d) / 1000),
          borderColor: options.actualColor,
          backgroundColor: options.actualColor,
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
          fill: false,
        },
        {
          label: options.predLabel,
          data: sorted.map(d => options.valuePred(d) / 1000),
          borderColor: options.predColor,
          backgroundColor: options.predColor,
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
          fill: false,
        },
      ],
    },
    options: getBaseOptions({ ...axis, yTitle: 'kWh' }, {
      ...getChartAnimations('line', sorted.length),
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
                html += ttRow(pt.dataset.borderColor, pt.dataset.label, `${fmtKwh(pt.raw)} kWh`);
              }
              return html;
            },
          }),
          callbacks: { title: axis.tooltipTitleCb },
        },
      },
    }),
    plugins: [dayDividersPlugin],
  });

  if (!diffCanvas) return;
  renderChart(diffCanvas, {
    type: 'line',
    data: {
      labels: axis.labels,
      datasets: [
        {
          label: 'Difference (pred − actual)',
          data: sorted.map(d => (options.valuePred(d) - options.valueActual(d)) / 1000),
          borderColor: 'rgba(100,116,139,0.6)',
          backgroundColor: 'transparent',
          borderWidth: 1,
          pointRadius: 0,
          tension: 0.3,
          fill: { target: 'origin', above: 'rgba(139,201,100,0.45)', below: 'rgba(233,122,131,0.45)' },
        },
      ],
    },
    options: getBaseOptions({ ...axis, yTitle: 'kWh diff' }, {
      ...getChartAnimations('line', sorted.length),
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
          enabled: false,
          external: createTooltipHandler({
            renderContent: (_idx, tooltip) => {
              const time = tooltip.title?.[0] ?? '';
              const pt = tooltip.dataPoints?.[0];
              if (!pt) return ttHeader(time);
              const v = pt.raw;
              const color = v >= 0 ? 'rgb(139,201,100)' : 'rgb(233,122,131)';
              let html = ttHeader(time);
              html += ttDivider();
              html += ttRow(color, 'Pred − Actual', `${v >= 0 ? '+' : ''}${fmtKwh(Math.abs(v))} kWh`);
              return html;
            },
          }),
          callbacks: { title: axis.tooltipTitleCb },
        },
      },
    }),
    plugins: [dayDividersPluginDiff],
  });
}
