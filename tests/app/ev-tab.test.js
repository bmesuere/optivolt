import { describe, expect, it } from 'vitest';
import { collectEvSettings } from '../../app/src/ev-tab.js';

describe('collectEvSettings — trips', () => {
  const trip = {
    id: 't1',
    type: 'trip',
    time: '2026-05-01T08:00:00.000Z',
    endTime: '2026-05-01T17:00:00.000Z',
    usage_percent: 25,
  };

  it('contributes a departure, an arrival, an away span, and a derived target', () => {
    const result = collectEvSettings([trip], 20);
    expect(result.departures).toEqual([trip.time]);
    expect(result.arrivals).toEqual([trip.endTime]);
    expect(result.trips).toEqual([{ from: trip.time, to: trip.endTime }]);
    expect(result.targets).toEqual([{ time: trip.time, soc_percent: 45 }]); // 25 + 20% buffer
  });

  it('caps the derived target at 100%', () => {
    const result = collectEvSettings([{ ...trip, usage_percent: 95 }], 20);
    expect(result.targets).toEqual([{ time: trip.time, soc_percent: 100 }]);
  });

  it('derives no target for a trip without a usage estimate', () => {
    const { usage_percent: _unused, ...noUsage } = trip;
    const result = collectEvSettings([noUsage], 20);
    expect(result.targets).toEqual([]);
    expect(result.trips).toEqual([{ from: trip.time, to: trip.endTime }]);
  });
});
