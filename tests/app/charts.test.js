import { describe, expect, it } from 'vitest';
import { aggregateLoadPvBuckets, getPriceStripColor } from '../../app/src/charts.js';

describe('getPriceStripColor', () => {
  it('uses a blue ramp when the buy price is negative (paid to consume)', () => {
    expect(getPriceStripColor(-0.5, -3)).toBe('rgb(182, 212, 253)');
    expect(getPriceStripColor(-5.5, -6)).toBe('rgb(99, 145, 236)');
    expect(getPriceStripColor(-10, -8)).toBe('rgb(29, 78, 216)');
    expect(getPriceStripColor(-20, -12)).toBe('rgb(29, 78, 216)');
  });

  it('uses a violet ramp when only the sell price is negative (injection costs money)', () => {
    expect(getPriceStripColor(8, -0.5)).toBe('rgb(215, 207, 254)');
    expect(getPriceStripColor(6, -5)).toBe('rgb(168, 144, 249)');
    expect(getPriceStripColor(5, -10)).toBe('rgb(124, 58, 237)');
    expect(getPriceStripColor(2, -20)).toBe('rgb(124, 58, 237)');
  });

  it('ramps light to deep within each buy-price band', () => {
    expect(getPriceStripColor(0, 2)).toBe('rgb(220, 252, 231)');
    expect(getPriceStripColor(7.5, 2)).toBe('rgb(136, 208, 153)');
    expect(getPriceStripColor(15, 2)).toBe('rgb(254, 249, 195)');
    expect(getPriceStripColor(17.5, 2)).toBe('rgb(245, 214, 125)');
    expect(getPriceStripColor(20, 2)).toBe('rgb(254, 215, 170)');
    expect(getPriceStripColor(25, 2)).toBe('rgb(254, 202, 202)');
    expect(getPriceStripColor(30, 2)).toBe('rgb(185, 28, 28)');
    expect(getPriceStripColor(40, 2)).toBe('rgb(127, 29, 29)');
    expect(getPriceStripColor(90, 2)).toBe('rgb(127, 29, 29)');
  });

  it('makes band boundaries a hard seam, not a smooth blend', () => {
    expect(getPriceStripColor(14.9, 2)).toBe('rgb(25, 164, 75)');
    expect(getPriceStripColor(15, 2)).toBe('rgb(254, 249, 195)');
    expect(getPriceStripColor(19.9, 2)).toBe('rgb(234, 180, 22)');
    expect(getPriceStripColor(20, 2)).toBe('rgb(254, 215, 170)');
  });

  it('falls back to the buy-price bands when the sell price is missing', () => {
    expect(getPriceStripColor(10)).toBe('rgb(106, 193, 127)');
    expect(getPriceStripColor(10, null)).toBe('rgb(106, 193, 127)');
  });

  it('treats invalid buy prices as neutral', () => {
    expect(getPriceStripColor(null, 2)).toBe('rgb(226, 232, 240)');
    expect(getPriceStripColor(Number.NaN, 2)).toBe('rgb(226, 232, 240)');
  });
});

describe('aggregateLoadPvBuckets', () => {
  it('keeps original hourly load and pv totals when adjusted slots are present', () => {
    const buckets = aggregateLoadPvBuckets([
      {
        timestampMs: Date.parse('2099-01-01T10:00:00.000Z'),
        load: 150,
        originalLoad: 100,
        pv: 20,
      },
      {
        timestampMs: Date.parse('2099-01-01T10:15:00.000Z'),
        load: 100,
        pv: 0,
        originalPv: 30,
      },
      {
        timestampMs: Date.parse('2099-01-01T10:30:00.000Z'),
        load: 100,
        pv: 10,
      },
      {
        timestampMs: Date.parse('2099-01-01T10:45:00.000Z'),
        load: 100,
        pv: 10,
      },
    ], 15);

    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({
      hasOriginalLoad: true,
      hasOriginalPv: true,
    });
    expect(buckets[0].loadKWh).toBeCloseTo(0.1125);
    expect(buckets[0].originalLoadKWh).toBeCloseTo(0.1);
    expect(buckets[0].pvKWh).toBeCloseTo(0.01);
    expect(buckets[0].originalPvKWh).toBeCloseTo(0.0175);
  });
});
