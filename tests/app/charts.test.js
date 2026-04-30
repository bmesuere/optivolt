import { describe, expect, it } from 'vitest';
import { aggregateLoadPvBuckets, getBuyPriceColor } from '../../app/src/charts.js';

describe('getBuyPriceColor', () => {
  it('uses fixed colors at scale stops', () => {
    expect(getBuyPriceColor(-10)).toBe('rgb(37, 99, 235)');
    expect(getBuyPriceColor(-1)).toBe('rgb(96, 165, 250)');
    expect(getBuyPriceColor(0)).toBe('rgb(226, 232, 240)');
    expect(getBuyPriceColor(1)).toBe('rgb(254, 243, 199)');
    expect(getBuyPriceColor(12)).toBe('rgb(251, 191, 36)');
    expect(getBuyPriceColor(24)).toBe('rgb(249, 115, 22)');
    expect(getBuyPriceColor(35)).toBe('rgb(220, 38, 38)');
  });

  it('clips prices outside the fixed scale', () => {
    expect(getBuyPriceColor(-50)).toBe('rgb(37, 99, 235)');
    expect(getBuyPriceColor(90)).toBe('rgb(220, 38, 38)');
  });

  it('makes small negative and positive prices visibly distinct', () => {
    expect(getBuyPriceColor(-1)).toBe('rgb(96, 165, 250)');
    expect(getBuyPriceColor(1)).toBe('rgb(254, 243, 199)');
  });

  it('interpolates between stops in OKLab space', () => {
    expect(getBuyPriceColor(-5.5)).toBe('rgb(65, 133, 243)');
    expect(getBuyPriceColor(-0.5)).toBe('rgb(162, 200, 247)');
    expect(getBuyPriceColor(6.5)).toBe('rgb(253, 218, 133)');
    expect(getBuyPriceColor(18)).toBe('rgb(252, 154, 29)');
    expect(getBuyPriceColor(30)).toBe('rgb(234, 78, 34)');
  });

  it('treats invalid prices as neutral zero', () => {
    expect(getBuyPriceColor(null)).toBe('rgb(226, 232, 240)');
    expect(getBuyPriceColor(Number.NaN)).toBe('rgb(226, 232, 240)');
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
