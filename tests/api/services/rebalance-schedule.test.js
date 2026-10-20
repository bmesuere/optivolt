import { describe, it, expect } from 'vitest';
import { getRebalanceSchedule } from '../../../api/services/rebalance-schedule.ts';

const DAY = 24 * 3600_000;
const NOW = Date.UTC(2026, 9, 19, 12);
const settings = (rebalanceEveryWeeks) => ({ rebalanceEveryWeeks });
const data = (lastDaysAgo, startMs = null) => ({
  lastRebalanceAt: lastDaysAgo == null ? null : new Date(NOW - lastDaysAgo * DAY).toISOString(),
  rebalanceState: { startMs },
});

describe('getRebalanceSchedule', () => {
  it('is off with an interval of 0', () => {
    expect(getRebalanceSchedule(settings(0), data(100), NOW)).toEqual({ active: false, dueMs: null, latestStartMs: null });
  });

  it('is due straight away when no rebalance was recorded, with a few days to pick the moment', () => {
    expect(getRebalanceSchedule(settings(4), data(null), NOW)).toEqual({ active: true, dueMs: NOW, latestStartMs: NOW + 3 * DAY });
  });

  it('waits until three days before the due date', () => {
    // Every 2 weeks, last one 10 days ago: due in 4 days.
    const early = getRebalanceSchedule(settings(2), data(10), NOW);
    expect(early.active).toBe(false);
    expect(early.dueMs).toBe(NOW + 4 * DAY);
    // Last one 12 days ago: due in 2 days, so planned, starting by 3 days after the due date.
    expect(getRebalanceSchedule(settings(2), data(12), NOW)).toEqual({ active: true, dueMs: NOW + 2 * DAY, latestStartMs: NOW + 5 * DAY });
  });

  it('leaves at least a day to reach the target once the window has passed', () => {
    expect(getRebalanceSchedule(settings(1), data(30), NOW).latestStartMs).toBe(NOW + DAY);
  });

  it('keeps a hold that has started going, uncapped', () => {
    expect(getRebalanceSchedule(settings(2), data(1, NOW - 3600_000), NOW)).toMatchObject({ active: true, latestStartMs: null });
  });
});
