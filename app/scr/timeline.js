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
