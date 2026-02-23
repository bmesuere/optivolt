/**
 * Utility functions for handling time series data.
 */

import type { TimeSeries } from './types.ts';

/**
 * Rounds a date down to the nearest step (default 15 minutes).
 */
export function getQuarterStart(date: Date | number | string = new Date(), stepMinutes = 15): number {
  const d = new Date(date);
  const q = Math.floor(d.getMinutes() / stepMinutes) * stepMinutes;
  d.setMinutes(q, 0, 0);
  return d.getTime();
}

/**
 * Extracts a window of data from a source time series to match a target start time.
 * Missing slots are padded with 0.
 */
export function extractWindow(source: TimeSeries, targetStartMs: number, targetEndMs: number): number[] {
  const sourceStartMs = new Date(source.start).getTime();
  const stepMs = (source.step || 15) * 60 * 1000;

  // Calculate offset in slots
  // If source starts BEFORE target, offset is positive (we skip some source data)
  // If source starts AFTER target, offset is negative (we need padding)
  const offsetMs = targetStartMs - sourceStartMs;
  const offsetSlots = Math.floor(offsetMs / stepMs);

  const targetDurationMs = targetEndMs - targetStartMs;
  const targetSlots = Math.floor(targetDurationMs / stepMs);

  const result: number[] = [];

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
