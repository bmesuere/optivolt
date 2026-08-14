// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  standardViewEndMs,
  sliceRowsToStandardView,
  planExceedsStandardView,
  rowsSpanHours,
  clampRebalanceWindow,
  aggregateRowsHourly,
  mapRebalanceWindowToRows,
} from '../../app/src/plan-view.js';

// Build rows at 15-min steps starting from a local time.
function makeRows(startLocal, count, fields = {}) {
  const startMs = startLocal.getTime();
  return Array.from({ length: count }, (_, i) => ({
    tIdx: i,
    timestampMs: startMs + i * 15 * 60_000,
    load: 400, pv: 0, ic: 20, ec: 8,
    g2l: 400, g2b: 0, pv2l: 0, pv2b: 0, pv2g: 0, b2l: 0, b2g: 0,
    imp: 400, exp: 0,
    importCost_cents: 2, exportCost_cents: 0,
    soc_percent: 50 + i,
    ...fields,
  }));
}

describe('standard view slicing', () => {
  it('ends at midnight tonight when the plan starts before 13:00', () => {
    const start = new Date(2026, 4, 1, 10, 0); // May 1st, 10:00 local
    expect(standardViewEndMs(start.getTime())).toBe(new Date(2026, 4, 2, 0, 0).getTime());
  });

  it('ends at midnight tomorrow when the plan starts at/after 13:00', () => {
    const start = new Date(2026, 4, 1, 14, 0);
    expect(standardViewEndMs(start.getTime())).toBe(new Date(2026, 4, 3, 0, 0).getTime());
  });

  it('slices rows to the standard window, keeping the prefix', () => {
    // 14:00 local + 4 days of slots; standard end = midnight tomorrow (34 h → 136 slots).
    const rows = makeRows(new Date(2026, 4, 1, 14, 0), 384);
    const sliced = sliceRowsToStandardView(rows);
    expect(sliced.length).toBe(136);
    expect(sliced[0]).toBe(rows[0]);
    expect(planExceedsStandardView(rows)).toBe(true);
  });

  it('returns the rows unchanged (same reference) when nothing extends past the window', () => {
    const rows = makeRows(new Date(2026, 4, 1, 14, 0), 96); // 24 h < 34 h window
    expect(sliceRowsToStandardView(rows)).toBe(rows);
    expect(planExceedsStandardView(rows)).toBe(false);
  });
});

describe('rowsSpanHours / clampRebalanceWindow', () => {
  it('computes the span in hours', () => {
    const rows = makeRows(new Date(2026, 4, 1, 0, 0), 97); // 96 steps of 15 min
    expect(rowsSpanHours(rows)).toBe(24);
  });

  it('clamps a rebalance window to the visible prefix', () => {
    expect(clampRebalanceWindow({ startIdx: 4, endIdx: 20 }, 10)).toEqual({ startIdx: 4, endIdx: 9 });
    expect(clampRebalanceWindow({ startIdx: 12, endIdx: 20 }, 10)).toBeNull();
    expect(clampRebalanceWindow(null, 10)).toBeNull();
  });
});

describe('aggregateRowsHourly', () => {
  it('preserves energy: mean W over the hour equals the summed slot energy', () => {
    const rows = makeRows(new Date(2026, 4, 1, 10, 0), 8, {});
    rows[0].g2l = 1000; rows[1].g2l = 0; rows[2].g2l = 0; rows[3].g2l = 0; // 0.25 kWh in hour 1
    const hourly = aggregateRowsHourly(rows, 15);
    expect(hourly).toHaveLength(2);
    // 1000 W for one 15-min slot = 250 Wh → 250 W hourly mean × 1 h.
    expect(hourly[0].g2l).toBe(250);
    expect(hourly[0].timestampMs).toBe(new Date(2026, 4, 1, 10, 0).getTime());
  });

  it('averages prices, sums costs, and keeps the last SoC of each hour', () => {
    const rows = makeRows(new Date(2026, 4, 1, 10, 0), 4);
    rows.forEach((r, i) => { r.ic = 10 + i; r.importCost_cents = 1; });
    const [hour] = aggregateRowsHourly(rows, 15);
    expect(hour.ic).toBe(11.5);
    expect(hour.importCost_cents).toBe(4);
    expect(hour.soc_percent).toBe(rows[3].soc_percent);
  });

  it('treats missing slots of a partial hour as zero energy', () => {
    // Plan starts at 10:45: one slot in the 10:00 hour.
    const rows = makeRows(new Date(2026, 4, 1, 10, 45), 5, { g2l: 1000 });
    const hourly = aggregateRowsHourly(rows, 15);
    expect(hourly[0].g2l).toBe(250); // 1000 W × 0.25 h = 250 Wh over the hour
    expect(hourly[1].g2l).toBe(1000);
  });

  it('only carries original predictions when a slot had one', () => {
    const rows = makeRows(new Date(2026, 4, 1, 10, 0), 4);
    expect(aggregateRowsHourly(rows, 15)[0].originalLoad).toBeUndefined();
    rows[1].originalLoad = 800;
    const [hour] = aggregateRowsHourly(rows, 15);
    // 3 slots at 400 (fallback to load) + 1 at 800, over 4 slots.
    expect(hour.originalLoad).toBe((400 * 3 + 800) / 4);
  });
});

describe('mapRebalanceWindowToRows', () => {
  it('re-expresses slot indices as hourly indices via timestamps', () => {
    const rows = makeRows(new Date(2026, 4, 1, 10, 0), 12); // 3 hours
    const hourly = aggregateRowsHourly(rows, 15);
    // Slots 5..9 → 11:15 to 12:15 → hourly indices 1..2.
    expect(mapRebalanceWindowToRows({ startIdx: 5, endIdx: 9 }, rows, hourly))
      .toEqual({ startIdx: 1, endIdx: 2 });
    expect(mapRebalanceWindowToRows(null, rows, hourly)).toBeNull();
  });
});
