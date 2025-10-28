// app/timeline.js
// Canonical timeline state for the current dataset.
let _activeTimestampsMs = null;

/** Read the current canonical per-slot timestamps (ms since epoch), or null. */
export function getActiveTimestampsMs() {
  return Array.isArray(_activeTimestampsMs) ? _activeTimestampsMs.slice() : null;
}

/** Overwrite the canonical timestamps (defensive copy), or clear with null/undefined. */
export function setActiveTimestampsMs(arr) {
  _activeTimestampsMs = Array.isArray(arr) ? arr.slice() : null;
}

/** Format Date -> "YYYY-MM-DDTHH:MM" for `<input type="datetime-local">` */
export function toLocalDatetimeLocal(dt) {
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = dt.getFullYear();
  const mm = pad(dt.getMonth() + 1);
  const dd = pad(dt.getDate());
  const HH = pad(dt.getHours());
  const MM = pad(dt.getMinutes());
  return `${yyyy}-${mm}-${dd}T${HH}:${MM}`;
}

/**
 * Build timing hints for parseSolution (pure).
 * @param {Object} cfg                    - solver cfg (must include stepSize_m and load_W)
 * @param {Object} opts
 * @param {number[]} [opts.candidate]     - preferred timestamps array to use if length matches T
 * @param {string}  [opts.tsStartValue]   - value from <input type="datetime-local">
 * @returns {{timestampsMs:null|number[], startMs:null|number, stepMin:number}}
 */
export function buildTimingHints(cfg, { candidate = null, tsStartValue = "" } = {}) {
  const T = Array.isArray(cfg?.load_W) ? cfg.load_W.length : 0;
  const hints = {
    timestampsMs: null,
    startMs: null,
    stepMin: Number(cfg?.stepSize_m) || 15,
  };

  if (Array.isArray(candidate) && candidate.length === T && T > 0) {
    hints.timestampsMs = candidate.slice();
    return hints;
  }

  if (tsStartValue) {
    const parsed = new Date(tsStartValue);
    if (!isNaN(parsed.getTime())) hints.startMs = parsed.getTime();
  }

  return hints;
}

/**
 * Convenience: run parseSolution() with proper timing hints and keep the canonical timeline in sync.
 * @param {*} result            - HiGHS result
 * @param {*} cfg               - solver cfg
 * @param {Function} parseSolution - (result, cfg, hints) => { rows, timestampsMs }
 * @param {string} [tsStartValue]   - raw value from the Start time input (optional)
 * @returns {{rows: any[], timestampsMs: number[]}}
 */
export function runParseSolutionWithTiming(result, cfg, parseSolution, tsStartValue = "") {
  const hints = buildTimingHints(cfg, {
    candidate: getActiveTimestampsMs(),
    tsStartValue,
  });
  const { rows, timestampsMs } = parseSolution(result, cfg, hints);
  setActiveTimestampsMs(timestampsMs); // keep canonical timeline synced
  return { rows, timestampsMs };
}

/**
 * If a forecast payload provides explicit timestamps, adopt them as canonical and (optionally)
 * return a value suitable for a datetime-local input to persist the first slot.
 * @param {{timestamps?: number[]}} fc
 * @returns {{adopted:boolean, firstInputValue:string|null}}
 */
export function adoptTimelineFromForecast(fc) {
  if (Array.isArray(fc?.timestamps) && fc.timestamps.length > 0) {
    setActiveTimestampsMs(fc.timestamps);
    const firstMs = fc.timestamps[0];
    return { adopted: true, firstInputValue: toLocalDatetimeLocal(new Date(firstMs)) };
  }
  setActiveTimestampsMs(null);
  return { adopted: false, firstInputValue: null };
}

/** Return ms timestamp floored to the last quarter (00/15/30/45) in local time.
 */
export function lastQuarterMs(baseDate = new Date()) {
  const d = new Date(baseDate);
  const q = Math.floor(d.getMinutes() / 15) * 15;
  d.setMinutes(q, 0, 0);
  return d.getTime();
}
