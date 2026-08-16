import { describe, expect, it } from 'vitest';
import { aggregateLoadPvBuckets, getPriceStripColor } from '../../app/src/charts.js';

describe('getPriceStripColor', () => {
  it('uses a flat blue when the buy price is negative (paid to consume)', () => {
    expect(getPriceStripColor(-0.1, -3)).toBe('rgb(37, 99, 235)');
    expect(getPriceStripColor(-10, -8)).toBe('rgb(37, 99, 235)');
    expect(getPriceStripColor(-20, -12)).toBe('rgb(37, 99, 235)');
  });

  it('uses a flat violet when only the sell price is negative (injection costs money)', () => {
    expect(getPriceStripColor(8, -0.1)).toBe('rgb(124, 58, 237)');
    expect(getPriceStripColor(5, -10)).toBe('rgb(124, 58, 237)');
    expect(getPriceStripColor(2, -20)).toBe('rgb(124, 58, 237)');
  });

  it('anchors hues at band centers along the positive scale', () => {
    expect(getPriceStripColor(0, 2)).toBe('rgb(187, 247, 208)');
    expect(getPriceStripColor(12.5, 2)).toBe('rgb(34, 197, 94)');
    expect(getPriceStripColor(17.5, 2)).toBe('rgb(234, 179, 8)');
    expect(getPriceStripColor(22.5, 2)).toBe('rgb(249, 115, 22)');
    expect(getPriceStripColor(27.5, 2)).toBe('rgb(220, 38, 38)');
    expect(getPriceStripColor(40, 2)).toBe('rgb(127, 29, 29)');
    expect(getPriceStripColor(90, 2)).toBe('rgb(127, 29, 29)');
  });

  it('keeps neighbouring positive prices near-identical', () => {
    expect(getPriceStripColor(9.9, 2)).toBe('rgb(81, 208, 119)');
    expect(getPriceStripColor(10.1, 2)).toBe('rgb(78, 207, 117)');
    expect(getPriceStripColor(24.9, 2)).toBe('rgb(236, 83, 33)');
    expect(getPriceStripColor(25.1, 2)).toBe('rgb(234, 80, 33)');
  });

  it('falls back to the positive scale when the sell price is missing', () => {
    expect(getPriceStripColor(10)).toBe('rgb(80, 207, 118)');
    expect(getPriceStripColor(10, null)).toBe('rgb(80, 207, 118)');
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
