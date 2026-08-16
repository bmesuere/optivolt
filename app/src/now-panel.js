/**
 * now-panel.js
 *
 * The "Now" block of the plan summary: what the plan says the battery is doing
 * in the slot we are currently in.
 *
 * The slot is picked by wall clock rather than taken as row 0, because a plan
 * is recomputed periodically and row 0 goes stale within its own quarter. A
 * ticker re-renders on the same basis so the block stays honest without a
 * page reload.
 *
 * This reports the *plan*, not measured hardware state — those diverge when
 * Victron overrides or the plan has expired.
 */

// Below this, a flow is rounding noise rather than a real decision.
const IDLE_THRESHOLD_W = 10;

/** Index of the row whose [t, t+step) contains nowMs, or -1 when outside the plan. */
export function findCurrentRowIndex(rows, stepSize_m = 15, nowMs = Date.now()) {
  if (!Array.isArray(rows) || rows.length === 0) return -1;
  const stepMs = stepSize_m * 60_000;
  for (let i = 0; i < rows.length; i++) {
    const start = rows[i].timestampMs;
    if (nowMs >= start && nowMs < start + stepMs) return i;
  }
  return -1;
}

/**
 * What the battery is doing this slot, derived from the solved flows rather
 * than the DESS strategy: the flows say what happens, the strategy is only the
 * instruction sent to Victron.
 */
export function describeSlotAction(row) {
  if (!row) return { label: "—", power_W: 0 };

  const toBattery = (row.g2b ?? 0) + (row.pv2b ?? 0);
  const fromBattery = (row.b2l ?? 0) + (row.b2g ?? 0) + (row.b2ev ?? 0);
  const evCharge = row.ev_charge ?? 0;

  if (toBattery >= fromBattery && toBattery > IDLE_THRESHOLD_W) {
    const pv = row.pv2b ?? 0;
    const grid = row.g2b ?? 0;
    let source = "grid";
    if (pv > IDLE_THRESHOLD_W && grid > IDLE_THRESHOLD_W) source = "grid + PV";
    else if (pv >= grid) source = "PV";
    return { label: `Charging from ${source}`, power_W: toBattery };
  }

  if (fromBattery > IDLE_THRESHOLD_W) {
    const toLoad = row.b2l ?? 0;
    const toGrid = row.b2g ?? 0;
    const toEv = row.b2ev ?? 0;
    const biggest = Math.max(toLoad, toGrid, toEv);
    let sink = "load";
    if (biggest === toGrid) sink = "grid";
    else if (biggest === toEv) sink = "EV";
    return { label: `Discharging to ${sink}`, power_W: fromBattery };
  }

  if (evCharge > IDLE_THRESHOLD_W) {
    return { label: "Charging EV", power_W: evCharge };
  }

  return { label: "Idle", power_W: 0 };
}

/**
 * Planned SoC entering slot `idx`. The first slot starts from the measured
 * value the plan was built on; later slots from the previous slot's result.
 */
export function socEnteringSlot(rows, idx, initialSoc_percent) {
  if (idx <= 0) {
    // Number(null) is 0, which would render a missing reading as an empty battery.
    const measured = initialSoc_percent == null ? NaN : Number(initialSoc_percent);
    return Number.isFinite(measured) ? measured : rows?.[0]?.soc_percent ?? null;
  }
  const prev = rows?.[idx - 1]?.soc_percent;
  return Number.isFinite(prev) ? prev : null;
}

function fmtClock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtPower(w) {
  const kw = w / 1000;
  return `${kw.toFixed(kw >= 10 ? 0 : 2)} kW`;
}

/** Render the block for `nowMs`. Safe to call with an empty plan. */
export function renderNowPanel(els, { rows = [], stepSize_m = 15, initialSoc_percent = null } = {}, nowMs = Date.now()) {
  const setText = (el, text) => { if (el) el.textContent = text; };

  const idx = findCurrentRowIndex(rows, stepSize_m, nowMs);
  if (idx < 0) {
    // Either no plan yet, or wall clock has run past the end of the last one.
    setText(els.nowSlotWindow, rows.length ? "plan expired" : "—");
    setText(els.nowAction, rows.length ? "Recompute for a current plan" : "—");
    setText(els.nowPower, "—");
    setText(els.nowSoc, "—");
    setText(els.nowSocTarget, "");
    return idx;
  }

  const row = rows[idx];
  const stepMs = stepSize_m * 60_000;
  setText(els.nowSlotWindow, `${fmtClock(row.timestampMs)} – ${fmtClock(row.timestampMs + stepMs)}`);

  const { label, power_W } = describeSlotAction(row);
  setText(els.nowAction, label);
  setText(els.nowPower, power_W > 0 ? fmtPower(power_W) : "—");

  const soc = socEnteringSlot(rows, idx, initialSoc_percent);
  setText(els.nowSoc, soc == null ? "—" : String(Math.round(soc)));

  const target = row.dess?.socTarget_percent;
  setText(els.nowSocTarget, Number.isFinite(target) ? `target ${Math.round(target)}%` : "");

  return idx;
}

/**
 * Keep the block in step with the wall clock. Returns a stop function.
 * A slot is 15 min, so a 30 s tick is far more than enough to land on the
 * right slot promptly without doing meaningful work.
 */
export function startNowPanelTicker(render, intervalMs = 30_000) {
  render();
  const id = setInterval(render, intervalMs);
  return () => clearInterval(id);
}
