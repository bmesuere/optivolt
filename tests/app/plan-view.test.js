// @vitest-environment jsdom
import { beforeEach, describe, it, expect } from 'vitest';
import {
  standardViewEndMs,
  sliceRowsToStandardView,
  rowsSpanHours,
  clampRebalanceWindow,
  aggregateRowsHourly,
  mapRebalanceWindowToRows,
  resolvePlanView,
  resolveViewWindow,
} from '../../app/src/plan-view.js';

// The window helpers read the stored range; keep every case explicit.
const viewWindow = (rows, standardEndMs = null) => resolveViewWindow({
  firstMs: rows[0].timestampMs,
  lastMs: rows[rows.length - 1].timestampMs,
  standardEndMs,
});

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
    expect(viewWindow(rows).hasExtended).toBe(true);
  });

  it('returns the rows unchanged (same reference) when nothing extends past the window', () => {
    const rows = makeRows(new Date(2026, 4, 1, 14, 0), 96); // 24 h < 34 h window
    expect(sliceRowsToStandardView(rows)).toBe(rows);
    expect(viewWindow(rows).hasExtended).toBe(false);
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

  it('averages ev_charge_A as energy-mean, not the last slot value', () => {
    // Only the first of four 15-min slots has EV charging.
    const rows = makeRows(new Date(2026, 4, 1, 10, 0), 4, { ev_charge: 0, ev_charge_A: 0 });
    rows[0].ev_charge = 4600; rows[0].ev_charge_A = 20;
    const [hour] = aggregateRowsHourly(rows, 15);
    // 20 A for one of four slots → energy-mean 5 A, not the last slot's 0 A.
    expect(hour.ev_charge_A).toBe(5);
  });

  it('keeps ev_charge_A unchanged for a full-hour constant charge', () => {
    const rows = makeRows(new Date(2026, 4, 1, 10, 0), 4, { ev_charge: 4600, ev_charge_A: 20 });
    const [hour] = aggregateRowsHourly(rows, 15);
    expect(hour.ev_charge_A).toBe(20);
  });

  it('keeps a mid-hour EV target instead of only the last slot of the hour', () => {
    const rows = makeRows(new Date(2026, 4, 1, 10, 0), 8);
    rows[1].ev_target_soc_percent = 80;
    const hourly = aggregateRowsHourly(rows, 15);
    expect(hourly[0].ev_target_soc_percent).toBe(80);
    expect(hourly[1].ev_target_soc_percent).toBeUndefined();
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

describe('server-provided standard boundary', () => {
  it('prefers the explicit boundary over the browser-local rule', () => {
    const rows = makeRows(new Date(2026, 4, 1, 14, 0), 384);
    // A server in another timezone hands us a different cutoff than the
    // local 34 h rule (136 slots): e.g. 24 h → 96 slots.
    const serverEndMs = rows[0].timestampMs + 24 * 3_600_000;
    expect(sliceRowsToStandardView(rows, serverEndMs)).toHaveLength(96);
    expect(viewWindow(rows, serverEndMs).hasExtended).toBe(true);
    // Non-finite boundary falls back to the local rule.
    expect(sliceRowsToStandardView(rows, null)).toHaveLength(136);
  });
});

describe('resolvePlanView', () => {
  // 14:00 local + 4 days of 15-min slots; the standard window ends at midnight
  // tomorrow (34 h → 136 slots), so this plan is an extended one.
  const rows = makeRows(new Date(2026, 4, 1, 14, 0), 384);

  beforeEach(() => localStorage.clear());

  it('slices to the standard window and charts it at slot resolution', () => {
    const view = resolvePlanView({ rows, stepSize_m: 15, rebalanceWindow: { startIdx: 100, endIdx: 200 } });

    expect(view.hasExtended).toBe(true);
    expect(view.view).toBe('standard');
    expect(view.rows).toHaveLength(136);
    expect(view.resolution).toBe('15');
    // Below the hourly threshold the charts draw the visible rows as they are.
    expect(view.chartRows).toBe(view.rows);
    expect(view.chartStepSize_m).toBe(15);
    // The window is cut off with the rows, and needs no remapping.
    expect(view.rebalanceWindow).toEqual({ startIdx: 100, endIdx: 135 });
    expect(view.chartRebalanceWindow).toEqual(view.rebalanceWindow);
  });

  it('shows the whole plan hourly in full view, with the window remapped', () => {
    localStorage.setItem('optivolt:viewRange', 'full');
    const view = resolvePlanView({ rows, stepSize_m: 15, rebalanceWindow: { startIdx: 4, endIdx: 11 } });

    expect(view.view).toBe('full');
    expect(view.rows).toBe(rows);
    // 95.75 h span → hourly bars by default.
    expect(view.resolution).toBe('60');
    expect(view.chartRows).toHaveLength(96);
    expect(view.chartStepSize_m).toBe(60);
    expect(view.rebalanceWindow).toEqual({ startIdx: 4, endIdx: 11 });
    // Slots 4..11 of a 14:00 start → 15:00–16:45 → hourly indices 1..2.
    expect(view.chartRebalanceWindow).toEqual({ startIdx: 1, endIdx: 2 });
  });

  it('honours an explicit hourly choice on a short plan', () => {
    localStorage.setItem('optivolt:flowsResolution', '60');
    const view = resolvePlanView({ rows: makeRows(new Date(2026, 4, 1, 14, 0), 8), stepSize_m: 15 });

    expect(view.hasExtended).toBe(false);
    expect(view.chartRows).toHaveLength(2);
    expect(view.chartStepSize_m).toBe(60);
  });

  it('is safe on an empty plan', () => {
    const view = resolvePlanView({ rows: [], stepSize_m: 15 });

    expect(view).toEqual({
      rows: [],
      view: 'standard',
      hasExtended: false,
      resolution: '15',
      rebalanceWindow: null,
      chartRows: [],
      chartStepSize_m: 15,
      chartRebalanceWindow: null,
    });
    expect(resolvePlanView()).toEqual(view);
  });
});

describe('aggregateRowsHourly — DST fall-back', () => {
  it('keeps the two occurrences of the repeated autumn hour in separate buckets', () => {
    // Brussels/Amsterdam falls back at 2026-10-25T01:00Z: local 02:00–02:59
    // happens twice. 8 slots covering 00:00Z–02:00Z are two physical hours.
    const startMs = Date.UTC(2026, 9, 25, 0, 0);
    const rows = Array.from({ length: 8 }, (_, i) => ({
      tIdx: i,
      timestampMs: startMs + i * 15 * 60_000,
      load: 400, pv: 0, ic: 20, ec: 8,
      g2l: 1000, g2b: 0, pv2l: 0, pv2b: 0, pv2g: 0, b2l: 0, b2g: 0,
      imp: 1000, exp: 0,
      importCost_cents: 1, exportCost_cents: 0,
      soc_percent: 50,
    }));

    const hourly = aggregateRowsHourly(rows, 15);
    expect(hourly).toHaveLength(2); // local-hour bucketing would collapse them into one
    expect(hourly.map(h => h.g2l)).toEqual([1000, 1000]);
    expect(hourly.map(h => h.timestampMs)).toEqual([startMs, startMs + 3_600_000]);
  });
});
