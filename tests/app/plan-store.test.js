import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginPlanRequest,
  getPlan,
  isCurrentPlanRequest,
  resetPlanStore,
  setPlan,
  subscribePlan,
} from '../../app/src/plan-store.js';

const payload = {
  rows: [{ tIdx: 0, timestampMs: 1714586400000, soc_percent: 55 }],
  summary: { netGridCost_cents: 12.5 },
  rebalanceWindow: { startIdx: 0, endIdx: 0 },
  rebalanceNudge: { rebalanceRecommended: true },
  initialSoc_percent: 42,
  pricesKnownUntilMs: 1714600000000,
  standardWindowEndMs: 1714604400000,
  tsStart: '2026-05-01T12:00:00.000Z',
};

beforeEach(() => resetPlanStore());

describe('plan store', () => {
  it('starts empty and hands out a readable plan', () => {
    expect(getPlan().rows).toEqual([]);
    expect(getPlan().summary).toBeNull();
    expect(getPlan().standardWindowEndMs).toBeNull();
  });

  it('keeps the plan fields consumers read', () => {
    setPlan(payload);

    expect(getPlan()).toEqual(payload);
    expect(getPlan().rows).toBe(payload.rows);
  });

  it('normalises a partial payload instead of leaking undefined', () => {
    setPlan({ rows: undefined, pricesKnownUntilMs: 'soon', standardWindowEndMs: NaN });

    expect(getPlan().rows).toEqual([]);
    expect(getPlan().summary).toBeNull();
    expect(getPlan().rebalanceNudge).toBeNull();
    expect(getPlan().pricesKnownUntilMs).toBeNull();
    expect(getPlan().standardWindowEndMs).toBeNull();
  });

  it('clears back to an empty plan', () => {
    setPlan(payload);
    setPlan(null);

    expect(getPlan().rows).toEqual([]);
    expect(getPlan().tsStart).toBeNull();
  });

  it('notifies subscribers with the stored plan until they unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribePlan(listener);

    setPlan(payload);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toBe(getPlan());

    unsubscribe();
    setPlan(payload);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  // The optimizer reports a failed render without discarding the solved plan,
  // which only works if the store lets the failure through.
  it('propagates a listener failure to the setter', () => {
    subscribePlan(() => { throw new Error('canvas exploded'); });

    expect(() => setPlan(payload)).toThrow('canvas exploded');
    expect(getPlan().rows).toBe(payload.rows);
  });

  it('only calls the newest request ticket current', () => {
    const stale = beginPlanRequest();
    expect(isCurrentPlanRequest(stale)).toBe(true);

    const fresh = beginPlanRequest();
    expect(isCurrentPlanRequest(stale)).toBe(false);
    expect(isCurrentPlanRequest(fresh)).toBe(true);
  });
});
