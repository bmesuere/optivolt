import { describe, it, expect } from 'vitest';
import {
  buildDemandChargeConfig,
  nextMonthStartMs,
  peakSensorToWatts,
  summarizeDemandCharge,
} from '../../lib/demand-charge.ts';

// Local-time constructors keep these tests independent of the configured TZ
// (vitest pins Europe/Amsterdam, which also exercises DST-free month ends here).
const local = (y, m, d, h = 0, min = 0) => new Date(y, m, d, h, min).getTime();

const base = {
  stepMin: 15,
  cost_eur_per_kW: 4,
  minPeak_W: 2500,
  margin_W: 0,
};

describe('nextMonthStartMs', () => {
  it('returns local midnight on the first of the next month', () => {
    expect(nextMonthStartMs(local(2026, 9, 21, 14, 30))).toBe(local(2026, 10, 1));
  });

  it('rolls over the year', () => {
    expect(nextMonthStartMs(local(2026, 11, 31, 23, 45))).toBe(local(2027, 0, 1));
  });
});

describe('buildDemandChargeConfig', () => {
  it('returns undefined when the cost is zero, so the LP stays unchanged', () => {
    expect(buildDemandChargeConfig({ ...base, cost_eur_per_kW: 0, startMs: local(2026, 9, 21), slotCount: 96 })).toBeUndefined();
  });

  it('converts €/kW to c€/kW', () => {
    const cfg = buildDemandChargeConfig({ ...base, startMs: local(2026, 9, 21), slotCount: 96 });
    expect(cfg.cost_cents_per_kW).toBe(400);
  });

  it('uses one period for a horizon inside a single month', () => {
    const cfg = buildDemandChargeConfig({ ...base, startMs: local(2026, 9, 21, 12), slotCount: 96 });
    expect(cfg.periods).toEqual([{ startSlot: 0, endSlot: 96, threshold_W: 2500 }]);
  });

  it('starts the current month from the peak already reached when it exceeds the minimum', () => {
    const cfg = buildDemandChargeConfig({ ...base, startMs: local(2026, 9, 21, 12), slotCount: 96, currentPeak_W: 4100 });
    expect(cfg.periods[0].threshold_W).toBe(4100);
  });

  it('never goes below the minimum billed peak', () => {
    const cfg = buildDemandChargeConfig({ ...base, startMs: local(2026, 9, 21, 12), slotCount: 96, currentPeak_W: 1200 });
    expect(cfg.periods[0].threshold_W).toBe(2500);
  });

  it('splits at the month boundary and resets the next month to the minimum', () => {
    // 2026-10-31 22:00 local; 8 slots before midnight, then November.
    const cfg = buildDemandChargeConfig({ ...base, startMs: local(2026, 9, 31, 22), slotCount: 96, currentPeak_W: 5000 });
    expect(cfg.periods).toEqual([
      { startSlot: 0, endSlot: 8, threshold_W: 5000 },
      { startSlot: 8, endSlot: 96, threshold_W: 2500 },
    ]);
  });

  it('subtracts the safety margin from every period, clamped at zero', () => {
    const cfg = buildDemandChargeConfig({ ...base, startMs: local(2026, 9, 31, 22), slotCount: 96, currentPeak_W: 5000, margin_W: 300 });
    expect(cfg.periods.map((p) => p.threshold_W)).toEqual([4700, 2200]);
    const zero = buildDemandChargeConfig({ ...base, minPeak_W: 0, startMs: local(2026, 9, 21), slotCount: 4, margin_W: 300 });
    expect(zero.periods[0].threshold_W).toBe(0);
  });

  it('treats an unknown or invalid current peak as the minimum', () => {
    for (const currentPeak_W of [undefined, Number.NaN]) {
      const cfg = buildDemandChargeConfig({ ...base, startMs: local(2026, 9, 21), slotCount: 4, currentPeak_W });
      expect(cfg.periods[0].threshold_W).toBe(2500);
    }
  });
});

describe('peakSensorToWatts', () => {
  it('reads kW and W', () => {
    expect(peakSensorToWatts('3.75', 'kW')).toBe(3750);
    expect(peakSensorToWatts('3750', 'W')).toBe(3750);
    expect(peakSensorToWatts('3.75', ' KW ')).toBe(3750);
  });

  it('rejects unavailable states, negative values and unknown units', () => {
    expect(peakSensorToWatts('unavailable', 'kW')).toBeUndefined();
    expect(peakSensorToWatts('-1', 'kW')).toBeUndefined();
    expect(peakSensorToWatts('3.75', 'kWh')).toBeUndefined();
    expect(peakSensorToWatts('3.75', undefined)).toBeUndefined();
  });
});

describe('summarizeDemandCharge', () => {
  const row = (t, imp) => ({ tIdx: t, timestampMs: 1000 * t, imp });
  const cfg = {
    cost_cents_per_kW: 400,
    periods: [
      { startSlot: 0, endSlot: 3, threshold_W: 2500 },
      { startSlot: 3, endSlot: 5, threshold_W: 2500 },
    ],
  };

  it('reports the planned peak and the cost of the excess per period', () => {
    const rows = [row(0, 1000), row(1, 3500), row(2, 2000), row(3, 2500), row(4, 800)];
    expect(summarizeDemandCharge(rows, cfg)).toEqual([
      { startMs: 0, threshold_W: 2500, plannedPeak_W: 3500, excess_W: 1000, cost_cents: 400 },
      { startMs: 3000, threshold_W: 2500, plannedPeak_W: 2500, excess_W: 0, cost_cents: 0 },
    ]);
  });

  it('ignores sub-watt solver noise at a binding threshold', () => {
    const rows = [row(0, 2500.4), row(1, 0), row(2, 0)];
    expect(summarizeDemandCharge(rows, { ...cfg, periods: [cfg.periods[0]] })[0].excess_W).toBe(0);
  });
});
