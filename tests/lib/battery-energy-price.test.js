import { describe, it, expect } from 'vitest';
import { estimateBatteryEnergyPrice, seedBatteryEnergyPrice, trackBatteryEnergyPrice } from '../../lib/battery-energy-price.ts';

const cfg = { stepSize_m: 60, chargeEfficiency_percent: 100, initialSoc_percent: 50, batteryCapacity_Wh: 10000 };
const row = (overrides) => ({ g2b: 0, pv2b: 0, ic: 0, soc_Wh: 5000, ...overrides });

describe('trackBatteryEnergyPrice', () => {
  it('blends grid charging into the seeded price by energy', () => {
    // 5 kWh at 10 c€ + 5 kWh bought at 30 c€ → 10 kWh at 20 c€.
    const prices = trackBatteryEnergyPrice([row({ g2b: 5000, ic: 30, soc_Wh: 10000 })], cfg, 10);
    expect(prices[0]).toBeCloseTo(20, 9);
  });

  it('counts solar as free and keeps the price while discharging', () => {
    const prices = trackBatteryEnergyPrice([
      row({ pv2b: 5000, soc_Wh: 10000 }), // 5 kWh at 10 + 5 kWh free → 5
      row({ soc_Wh: 2000 }),              // discharge: unchanged
    ], cfg, 10);
    expect(prices[0]).toBeCloseTo(5, 9);
    expect(prices[1]).toBeCloseTo(5, 9);
  });

  it('includes charge losses in the price per stored kWh', () => {
    // 4 kWh bought at 18 c€ stores 3.6 kWh → 20 c€ per stored kWh.
    const prices = trackBatteryEnergyPrice(
      [row({ g2b: 4000, ic: 18, soc_Wh: 3600 })],
      { ...cfg, chargeEfficiency_percent: 90, initialSoc_percent: 0 },
      null,
    );
    expect(prices[0]).toBeCloseTo(20, 9);
  });

  it('stays unknown without a seed until the first charge, then ignores the unpriced energy', () => {
    const prices = trackBatteryEnergyPrice([
      row({ soc_Wh: 4000 }),
      row({ g2b: 2000, ic: 25, soc_Wh: 6000 }),
    ], cfg, null);
    expect(prices[0]).toBeNull();
    expect(prices[1]).toBeCloseTo(25, 9);
  });
});

describe('seedBatteryEnergyPrice', () => {
  const prev = { startMs: 0, stepMin: 15, seed_cents_per_kWh: 8, prices: [9, 10, 11] };

  it('is unknown without a previous plan', () => {
    expect(seedBatteryEnergyPrice(undefined, 0)).toBeNull();
  });

  it('reuses the seed for a recompute in the same slot', () => {
    expect(seedBatteryEnergyPrice(prev, 5 * 60_000)).toBe(8);
  });

  it('takes the price at the end of the slot before the new start', () => {
    expect(seedBatteryEnergyPrice(prev, 15 * 60_000)).toBe(9);
    expect(seedBatteryEnergyPrice(prev, 30 * 60_000)).toBe(10);
  });

  it('falls back to the last tracked price past the previous horizon', () => {
    expect(seedBatteryEnergyPrice(prev, 10 * 3_600_000)).toBe(11);
  });
});

describe('estimateBatteryEnergyPrice', () => {
  it('averages the cheapest quarter of the first day only', () => {
    // Day 1: six hours at 10 and 12 (the cheapest quarter), the rest at 30. Day 2 is ignored.
    const day1 = [10, 12, 10, 12, 10, 12, ...Array(18).fill(30)].map((ic) => ({ ic }));
    const rows = [...day1, ...Array(24).fill({ ic: 1 })];
    expect(estimateBatteryEnergyPrice(rows, 60)).toBeCloseTo(11, 9);
    expect(estimateBatteryEnergyPrice([], 60)).toBeNull();
  });
});
