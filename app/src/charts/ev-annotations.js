import { fmtHHMM } from './core.js';

export function findDepartureSlotIdx(rows, departureTime) {
  if (!departureTime) return -1;
  const depMs = new Date(departureTime).getTime();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].timestampMs >= depMs) return i;
  }
  return -1;
}

export function makeEvDeparturePlugin(rows, departureTime) {
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

export function makeEvTargetPlugin(rows, departureTime, targetSoc_percent) {
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
