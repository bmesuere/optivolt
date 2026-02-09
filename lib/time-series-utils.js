/**
 * Utility functions for handling time series data.
 */

/**
 * Calculates the start of the 15-minute interval containing the given date (or now).
 * Rounds down to the nearest 15 minutes.
 * @param {Date|number|string} date
 * @returns {number} timestamp in ms
 */
export function getQuarterStart(date = new Date()) {
  const d = new Date(date);
  const q = Math.floor(d.getMinutes() / 15) * 15;
  d.setMinutes(q, 0, 0);
  return d.getTime();
}

/**
 * Extracts a window of data from a source time series to match a target start time.
 *
 * @param {Object} source The source data object.
 * @param {string|number|Date} source.start ISO string, timestamp or Date of the series start.
 * @param {number} [source.step=15] Step size in minutes.
 * @param {number[]} source.values The array of values.
 * @param {number} targetStartMs The target start timestamp in ms.
 * @param {number} targetEndMs The target end timestamp in ms (exclusive).
 * @returns {number[]} The sliced and aligned array.
 */
export function extractWindow(source, targetStartMs, targetEndMs) {
  const sourceStartMs = new Date(source.start).getTime();
  const stepMs = (source.step || 15) * 60 * 1000;

  // Calculate offset in slots
  // If source starts BEFORE target, offset is positive (we skip some source data)
  // If source starts AFTER target, offset is negative (we need padding)
  const offsetMs = targetStartMs - sourceStartMs;
  const offsetSlots = Math.floor(offsetMs / stepMs);

  const targetDurationMs = targetEndMs - targetStartMs;
  const targetSlots = Math.floor(targetDurationMs / stepMs);

  const result = [];

  for (let i = 0; i < targetSlots; i++) {
    const sourceIndex = offsetSlots + i;

    if (sourceIndex >= 0 && sourceIndex < source.values.length) {
      result.push(source.values[sourceIndex]);
    } else {
      // Pad with 0 for missing data
      result.push(0);
    }
  }

  return result;
}
