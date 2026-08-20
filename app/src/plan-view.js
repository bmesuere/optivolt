/**
 * plan-view.js
 *
 * How a plan is turned into what a tab actually draws: resolving the visible
 * window from the view toggles, slicing to it, picking a bar resolution,
 * aggregating to hourly, and re-expressing the rebalance window on the result.
 *
 * `resolvePlanView` is that whole sequence for row-shaped data (optimizer and
 * EV tabs); the forecast chart is series-shaped and shares the window half via
 * `resolveViewWindow`. The individual steps stay exported because they are
 * independently useful (and independently testable).
 *
 * Also holds the client-side persistence of the view toggles themselves.
 */

const VIEW_RANGE_KEY = "optivolt:viewRange";
const FLOWS_RES_KEY = "optivolt:flowsResolution";

/**
 * Fallback end of the "standard" view for a plan starting at the given
 * timestamp: the classic day-ahead window (local midnight tonight before
 * 13:00, midnight tomorrow after). Only used when the server didn't provide
 * `standardWindowEndMs` — the browser's timezone may differ from the one the
 * plan was made in, so the server value is authoritative.
 */
export function standardViewEndMs(firstTimestampMs) {
  const d = new Date(firstTimestampMs);
  const dayOffset = d.getHours() < 13 ? 1 : 2;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, 0, 0, 0, 0).getTime();
}

function resolveStandardEndMs(rows, standardEndMs) {
  return Number.isFinite(standardEndMs) ? standardEndMs : standardViewEndMs(rows[0].timestampMs);
}

function sliceRowsAtCut(rows, cutMs) {
  const idx = rows.findIndex((r) => r.timestampMs >= cutMs);
  return idx < 0 ? rows : rows.slice(0, idx);
}

/**
 * Rows within the standard window (a prefix of the plan, so slot indices are
 * preserved). `standardEndMs` is the server-provided boundary; without it the
 * browser-local fallback applies.
 */
export function sliceRowsToStandardView(rows, standardEndMs = null) {
  if (!Array.isArray(rows) || rows.length === 0) return rows ?? [];
  return sliceRowsAtCut(rows, resolveStandardEndMs(rows, standardEndMs));
}

/**
 * Resolution for a view spanning `spanH` hours: the user's explicit choice if
 * they made one, otherwise hourly beyond 48 h to keep multi-day bars readable.
 */
export function resolveFlowsResolution(spanH) {
  return getStoredFlowsResolution() ?? (spanH > 48 ? "60" : "15");
}

/**
 * Which part of a horizon the view toggles currently show. `firstMs`/`lastMs`
 * are the first and last *slot start* timestamps of the data; `standardEndMs`
 * is the server-provided window boundary, with the browser-local day-ahead
 * rule as fallback. `cutMs` is where the standard view stops — null in full
 * view, i.e. "show everything".
 */
export function resolveViewWindow({ firstMs, lastMs, standardEndMs = null }) {
  const endMs = Number.isFinite(standardEndMs) ? standardEndMs : standardViewEndMs(firstMs);
  const hasExtended = lastMs >= endMs;
  const view = hasExtended ? getStoredViewRange() : "standard";
  return { hasExtended, view, cutMs: view === "full" ? null : endMs };
}

/** Span of the given rows in hours (0 for empty/single-row input). */
export function rowsSpanHours(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return 0;
  return (rows[rows.length - 1].timestampMs - rows[0].timestampMs) / 3_600_000;
}

/**
 * Clamp a rebalance window (slot indices into the full plan) to the first
 * `visibleLength` rows. Standard-view slicing keeps the row prefix, so
 * indices stay valid — the window just gets cut off or dropped.
 */
export function clampRebalanceWindow(window, visibleLength) {
  if (!window || window.startIdx >= visibleLength) return null;
  return { startIdx: window.startIdx, endIdx: Math.min(window.endIdx, visibleLength - 1) };
}

// Flow-like fields: aggregated so that mean W × 1 h equals the summed slot
// energy (missing slots in a partial hour count as zero).
const ENERGY_MEAN_KEYS = [
  "load", "pv",
  "g2l", "g2b", "pv2l", "pv2b", "pv2g", "b2l", "b2g",
  "g2ev", "pv2ev", "b2ev", "ev_charge", "ev_charge_A",
  "imp", "exp",
];
const SUM_KEYS = ["importCost_cents", "exportCost_cents"];
const SLOT_MEAN_KEYS = ["ic", "ec"]; // prices: plain mean over present slots

/**
 * Aggregate 15-min plan rows into hourly rows of the same shape, for readable
 * bar charts on multi-day horizons. Flows become the hour's average power
 * (energy-preserving: mean W × 1 h = summed slot energy), prices the mean,
 * costs the sum, and SoC values the hour's last slot.
 */
export function aggregateRowsHourly(rows, stepSize_m = 15) {
  const slotsPerHour = Math.max(1, Math.round(60 / stepSize_m));
  const buckets = new Map();

  for (const row of rows) {
    // Bucket by absolute hour (epoch floor), not local wall-clock: at the
    // autumn DST transition the repeated local hour would otherwise collapse
    // two physical hours into one bucket.
    const hourMs = Math.floor(row.timestampMs / 3_600_000) * 3_600_000;
    if (!buckets.has(hourMs)) {
      buckets.set(hourMs, { rows: [], hourMs });
    }
    buckets.get(hourMs).rows.push(row);
  }

  return [...buckets.values()]
    .sort((a, b) => a.hourMs - b.hourMs)
    .map(({ rows: slotRows, hourMs }, bucketIdx) => {
      const last = slotRows[slotRows.length - 1];
      const out = { ...last, tIdx: bucketIdx, timestampMs: hourMs };
      for (const key of ENERGY_MEAN_KEYS) {
        out[key] = slotRows.reduce((sum, r) => sum + (Number(r[key]) || 0), 0) / slotsPerHour;
      }
      for (const key of SUM_KEYS) {
        out[key] = slotRows.reduce((sum, r) => sum + (Number(r[key]) || 0), 0);
      }
      for (const key of SLOT_MEAN_KEYS) {
        out[key] = slotRows.reduce((sum, r) => sum + (Number(r[key]) || 0), 0) / slotRows.length;
      }
      // Original (pre-adjustment) predictions, only when some slot carried one.
      for (const [key, base] of [["originalLoad", "load"], ["originalPv", "pv"]]) {
        if (slotRows.some((r) => r[key] != null)) {
          out[key] = slotRows.reduce((sum, r) => sum + (Number(r[key] ?? r[base]) || 0), 0) / slotsPerHour;
        } else {
          delete out[key];
        }
      }
      return out;
    });
}

/** Re-express a rebalance window given in `sourceRows` indices as indices into `targetRows` (by timestamp). */
export function mapRebalanceWindowToRows(window, sourceRows, targetRows) {
  if (!window) return null;
  const startMs = sourceRows[window.startIdx]?.timestampMs;
  const endMs = sourceRows[window.endIdx]?.timestampMs;
  if (startMs == null || endMs == null) return null;
  const containing = (ms) => {
    let idx = -1;
    for (let i = 0; i < targetRows.length; i++) {
      if (targetRows[i].timestampMs <= ms) idx = i;
      else break;
    }
    return idx;
  };
  const startIdx = containing(startMs);
  const endIdx = containing(endMs);
  if (startIdx < 0 || endIdx < 0) return null;
  return { startIdx, endIdx };
}

/**
 * The whole view pipeline for a plan: window → slice → resolution → aggregate
 * → rebalance-window remap. Every tab that charts plan rows renders from this
 * one result, so they cannot drift apart.
 *
 * Returns the visible rows (a prefix of the plan, slot indices preserved) plus
 * the `chart*` fields, which are the same rows aggregated to hourly when the
 * resolution says so — draw the charts from those, the table from `rows`.
 */
export function resolvePlanView({
  rows = [],
  stepSize_m = 15,
  standardEndMs = null,
  rebalanceWindow = null,
} = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      rows: [],
      view: "standard",
      hasExtended: false,
      resolution: resolveFlowsResolution(0),
      rebalanceWindow: null,
      chartRows: [],
      chartStepSize_m: stepSize_m,
      chartRebalanceWindow: null,
    };
  }

  const { hasExtended, view, cutMs } = resolveViewWindow({
    firstMs: rows[0].timestampMs,
    lastMs: rows[rows.length - 1].timestampMs,
    standardEndMs,
  });
  const visibleRows = cutMs == null ? rows : sliceRowsAtCut(rows, cutMs);
  const clamped = clampRebalanceWindow(rebalanceWindow, visibleRows.length);

  // Hourly bars keep multi-day views readable, so that is the default beyond
  // 48 h — but the control is always available, whatever the span.
  const resolution = resolveFlowsResolution(rowsSpanHours(visibleRows));
  const hourly = resolution === "60";
  const chartRows = hourly ? aggregateRowsHourly(visibleRows, stepSize_m) : visibleRows;

  return {
    rows: visibleRows,
    view,
    hasExtended,
    resolution,
    rebalanceWindow: clamped,
    chartRows,
    chartStepSize_m: hourly ? 60 : stepSize_m,
    chartRebalanceWindow: hourly
      ? mapRebalanceWindowToRows(clamped, visibleRows, chartRows)
      : clamped,
  };
}

// ---------------------------------------------------------------------------
// Client-side persistence of the view toggles (localStorage; never synced)
// ---------------------------------------------------------------------------

export function getStoredViewRange() {
  try {
    return localStorage.getItem(VIEW_RANGE_KEY) === "full" ? "full" : "standard";
  } catch {
    return "standard";
  }
}

export function storeViewRange(range) {
  try {
    localStorage.setItem(VIEW_RANGE_KEY, range === "full" ? "full" : "standard");
  } catch { /* private mode etc. — the toggle just won't persist */ }
}

/** Explicit user choice ('15' | '60'), or null meaning "auto". */
export function getStoredFlowsResolution() {
  try {
    const v = localStorage.getItem(FLOWS_RES_KEY);
    return v === "15" || v === "60" ? v : null;
  } catch {
    return null;
  }
}

export function storeFlowsResolution(res) {
  try {
    localStorage.setItem(FLOWS_RES_KEY, res === "60" ? "60" : "15");
  } catch { /* ignore */ }
}
