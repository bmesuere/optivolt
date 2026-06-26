import { fmtHHMM } from './core.js';

export function findDepartureSlotIdx(rows, departureTime) {
  if (!departureTime) return -1;
  const depMs = new Date(departureTime).getTime();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].timestampMs >= depMs) return i;
  }
  return -1;
}

// Draw a dashed vertical line + time label at each of the given event times.
function makeEvEventPlugin(id, color, labelY, rows, times) {
  const marks = (times ?? [])
    .map(time => ({ idx: findDepartureSlotIdx(rows, time), time }))
    .filter(m => m.idx >= 0);
  if (marks.length === 0) return null;

  return {
    id,
    afterDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea) return;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1.5;
      ctx.font = '500 10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      for (const { idx, time } of marks) {
        const xPx = scales.x.getPixelForValue(idx);
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(xPx, chartArea.top);
        ctx.lineTo(xPx, chartArea.bottom);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillText(fmtHHMM(new Date(time)), xPx, chartArea.top + labelY);
      }
      ctx.restore();
    }
  };
}

// Vertical line at each departure (the car leaves) — emerald, matching the "leaves" badge.
export function makeEvDeparturePlugin(rows, departureTimes) {
  return makeEvEventPlugin('evDeparture', 'rgba(16, 185, 129, 0.75)', 10, rows, departureTimes);
}

// Vertical line at each arrival (the car (re)connects) — sky, matching the "arrives" badge.
export function makeEvArrivalPlugin(rows, arrivalTimes) {
  return makeEvEventPlugin('evArrival', 'rgba(14, 165, 233, 0.75)', 22, rows, arrivalTimes);
}

/**
 * Draw one or more SoC deadlines. Each target is { time, soc_percent }, independent of the
 * departure time. To keep multiple targets legible, each is drawn as an L-corner that stops at
 * its crossing point — a horizontal segment from the left axis and a vertical segment from the
 * bottom axis, meeting at a dot at (deadline slot, target SoC) — rather than full-width lines.
 */
export function makeEvTargetPlugin(rows, targets) {
  const active = (targets ?? []).filter(t => t && t.time && t.soc_percent > 0);
  if (active.length === 0) return null;

  const color = 'rgba(16, 185, 129, 0.85)';

  return {
    id: 'evTarget',
    afterDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea) return;
      const { x: xScale, y: yScale } = scales;

      ctx.save();
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1.5;
      ctx.font = '600 10px system-ui, sans-serif';

      for (const { time, soc_percent } of active) {
        const idx = findDepartureSlotIdx(rows, time);
        // No matching slot (deadline at/after the horizon end): pin the corner to the right edge.
        const xPx = idx >= 0 ? xScale.getPixelForValue(idx) : chartArea.right;
        const yPx = yScale.getPixelForValue(soc_percent);

        // L-corner: stop both segments at the crossing so it's clear which level pairs with which time.
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(chartArea.left, yPx); // horizontal: left axis → crossing
        ctx.lineTo(xPx, yPx);
        ctx.lineTo(xPx, chartArea.bottom); // vertical: crossing → bottom axis
        ctx.stroke();
        ctx.setLineDash([]);

        // Dot at the crossing point.
        ctx.beginPath();
        ctx.arc(xPx, yPx, 3, 0, Math.PI * 2);
        ctx.fill();

        // Label the level just above-left of the dot, clamped inside the chart.
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        const labelX = Math.max(chartArea.left + 24, xPx - 5);
        ctx.fillText(`${soc_percent}%`, labelX, yPx - 4);
      }

      ctx.restore();
    }
  };
}
