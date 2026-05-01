import { describe, expect, it } from 'vitest';
import {
  getRebalanceNudge,
  recordFullSocObservation,
} from '../../../api/services/rebalance-nudge.ts';
import { validateData } from '../../../api/services/data-store.ts';

const baseData = {
  load: { start: '2024-01-01T00:00:00.000Z', values: [] },
  pv: { start: '2024-01-01T00:00:00.000Z', values: [] },
  importPrice: { start: '2024-01-01T00:00:00.000Z', values: [] },
  exportPrice: { start: '2024-01-01T00:00:00.000Z', values: [] },
  soc: { timestamp: '2024-01-01T00:00:00.000Z', value: 50 },
};

describe('rebalance nudge helpers', () => {
  it('records the SoC timestamp when the battery reaches 100%', () => {
    const data = {
      ...baseData,
      soc: { timestamp: '2024-01-02T03:04:05Z', value: 100 },
    };

    expect(recordFullSocObservation(data)).toEqual({
      ...data,
      lastFullSocAt: '2024-01-02T03:04:05.000Z',
    });
  });

  it('does not record when the observed SoC is below 100%', () => {
    const data = {
      ...baseData,
      soc: { timestamp: '2024-01-02T03:04:05Z', value: 99.9 },
    };

    expect(recordFullSocObservation(data)).toBe(data);
  });

  it('does not move the last full timestamp backwards', () => {
    const data = {
      ...baseData,
      lastFullSocAt: '2024-01-05T00:00:00.000Z',
      soc: { timestamp: '2024-01-02T00:00:00.000Z', value: 100 },
    };

    expect(recordFullSocObservation(data)).toBe(data);
  });

  it('recommends rebalancing after more than 10 days without a full charge', () => {
    const nudge = getRebalanceNudge(
      { ...baseData, lastFullSocAt: '2024-01-01T00:00:00.000Z' },
      new Date('2024-01-12T00:00:01.000Z').getTime(),
    );

    expect(nudge).toMatchObject({
      daysSinceLastFullSoc: 11,
      rebalanceRecommended: true,
      thresholdDays: 10,
    });
  });

  it('does not recommend rebalancing when full-charge history is unknown', () => {
    expect(getRebalanceNudge(baseData)).toEqual({
      lastFullSocAt: null,
      daysSinceLastFullSoc: null,
      rebalanceRecommended: false,
      thresholdDays: 10,
    });
  });

  it('accepts missing and null lastFullSocAt in persisted data', () => {
    expect(validateData(baseData)).toBe(baseData);
    expect(validateData({ ...baseData, lastFullSocAt: null })).toMatchObject({
      lastFullSocAt: null,
    });
  });
});
