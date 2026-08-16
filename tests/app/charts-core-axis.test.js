// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { buildTimeAxisFromTimestamps } from '../../app/src/charts/core.js';

/** Build `count` timestamps at `stepMin` intervals from a local wall-clock start. */
function series(startLocal, count, stepMin = 15) {
  const start = new Date(startLocal).getTime();
  return Array.from({ length: count }, (_, i) => start + i * stepMin * 60_000);
}

const ticksOf = (timestamps) => {
  const axis = buildTimeAxisFromTimestamps(timestamps);
  return timestamps.map((_, i) => axis.ticksCb(null, i));
};

describe('buildTimeAxisFromTimestamps — tick labels', () => {
  it('labels midnight with the three-letter weekday, not a date', () => {
    // 2026-08-16 is a Sunday, so midnight ticks land on Mon and Tue.
    const ticks = ticksOf(series('2026-08-16T22:00:00', 4 * 24 * 3, 15));

    expect(ticks).toContain('Mon');
    expect(ticks).toContain('Tue');
    expect(ticks.some(t => /^\d{2}\/\d{2}$/.test(t))).toBe(false);
  });

  it('still labels other hours as HH:00', () => {
    const ticks = ticksOf(series('2026-08-17T00:00:00', 24 * 4, 15));

    expect(ticks[0]).toBe('Mon');
    expect(ticks).toContain('04:00');
    expect(ticks).toContain('08:00');
  });

  it('leaves non-full-hour slots unlabelled', () => {
    const ticks = ticksOf(series('2026-08-17T00:00:00', 8, 15));

    expect(ticks[0]).toBe('Mon');
    expect(ticks[1]).toBe('');
    expect(ticks[2]).toBe('');
    expect(ticks[3]).toBe('');
  });
});
