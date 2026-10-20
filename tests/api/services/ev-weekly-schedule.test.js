import { describe, it, expect } from 'vitest';
import {
  parseHhMm,
  normalizeWeeklySchedule,
  expandWeeklySchedule,
  weeklyScheduleEntries,
} from '../../../api/services/ev-weekly-schedule.ts';

// Tests run with TZ=Europe/Amsterdam (vitest.config.js); local wall-clock helpers keep them readable.
const local = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
// 2026-10-12 is a Monday.
const MON_NOON = local(2026, 10, 12, 12);
const WEEK_MS = 7 * 24 * 3600_000;

describe('parseHhMm', () => {
  it('parses valid 24 h times and rejects anything else', () => {
    expect(parseHhMm('00:00')).toBe(0);
    expect(parseHhMm('18:30')).toBe(18 * 60 + 30);
    expect(parseHhMm('23:59')).toBe(23 * 60 + 59);
    for (const bad of ['24:00', '7:00', '18:60', '', null, 1800]) expect(parseHhMm(bad)).toBeNull();
  });
});

describe('normalizeWeeklySchedule', () => {
  it('accepts a valid schedule and treats null as empty', () => {
    expect(normalizeWeeklySchedule(null)).toEqual([]);
    expect(normalizeWeeklySchedule([{ weekday: '3', start: ' 18:00', end: '07:00', soc_percent: '80' }]))
      .toEqual([{ weekdays: [3], start: '18:00', end: '07:00', soc_percent: 80, ess_soc_percent: 100 }]);
  });

  it('accepts several weekdays per plan, sorted and de-duplicated, and none at all', () => {
    expect(normalizeWeeklySchedule([{ weekdays: [5, '1', 3, 1], start: '18:00', end: '07:00', soc_percent: 80 }]))
      .toEqual([{ weekdays: [1, 3, 5], start: '18:00', end: '07:00', soc_percent: 80, ess_soc_percent: 100 }]);
    expect(normalizeWeeklySchedule([{ weekdays: [], start: '18:00', end: '07:00', soc_percent: 80 }]))
      .toEqual([{ weekdays: [], start: '18:00', end: '07:00', soc_percent: 80, ess_soc_percent: 100 }]);
  });

  it('keeps a home battery target and rejects one out of range', () => {
    expect(normalizeWeeklySchedule([{ weekdays: [3], start: '18:00', end: '07:00', soc_percent: 80, ess_soc_percent: '90' }])[0].ess_soc_percent)
      .toBe(90);
    expect(() => normalizeWeeklySchedule([{ weekdays: [3], start: '18:00', end: '07:00', soc_percent: 80, ess_soc_percent: 101 }]))
      .toThrow('evWeeklySchedule[0].ess_soc_percent');
  });

  it('rejects malformed slots with a field-specific message', () => {
    expect(() => normalizeWeeklySchedule([{ start: '18:00', end: '07:00', soc_percent: 80 }]))
      .toThrow('evWeeklySchedule[0].weekdays');
    expect(() => normalizeWeeklySchedule({})).toThrow('must be an array');
    expect(() => normalizeWeeklySchedule([{ weekday: 7, start: '18:00', end: '07:00', soc_percent: 80 }]))
      .toThrow('evWeeklySchedule[0].weekdays');
    expect(() => normalizeWeeklySchedule([{ weekday: 3, start: '18h', end: '07:00', soc_percent: 80 }]))
      .toThrow('evWeeklySchedule[0].start');
    expect(() => normalizeWeeklySchedule([{ weekday: 3, start: '18:00', end: '07:00', soc_percent: 120 }]))
      .toThrow('evWeeklySchedule[0].soc_percent');
  });
});

describe('expandWeeklySchedule', () => {
  it('repeats one plan on each selected weekday and skips a plan without days', () => {
    const occ = expandWeeklySchedule(
      [
        { weekdays: [3, 5], start: '18:00', end: '22:00', soc_percent: 80 },
        { weekdays: [], start: '08:00', end: '10:00', soc_percent: 50 },
      ],
      MON_NOON,
      MON_NOON + WEEK_MS,
    );
    expect(occ).toEqual([
      { startMs: local(2026, 10, 14, 18), endMs: local(2026, 10, 14, 22), soc_percent: 80, ess_soc_percent: 100 },
      { startMs: local(2026, 10, 16, 18), endMs: local(2026, 10, 16, 22), soc_percent: 80, ess_soc_percent: 100 },
    ]);
  });

  it('expands an overnight Wednesday window into the next day', () => {
    const occ = expandWeeklySchedule(
      [{ weekdays: [3], start: '18:00', end: '07:00', soc_percent: 80 }],
      MON_NOON,
      MON_NOON + WEEK_MS,
    );
    expect(occ).toEqual([
      { startMs: local(2026, 10, 14, 18), endMs: local(2026, 10, 15, 7), soc_percent: 80, ess_soc_percent: 100 },
    ]);
  });

  it('returns Wednesday and Sunday windows in time order', () => {
    const occ = expandWeeklySchedule(
      [
        { weekdays: [0], start: '20:00', end: '07:00', soc_percent: 60 },
        { weekdays: [3], start: '18:00', end: '22:00', soc_percent: 80 },
      ],
      MON_NOON,
      MON_NOON + WEEK_MS,
    );
    expect(occ.map((o) => [new Date(o.startMs).getDay(), o.soc_percent])).toEqual([[3, 80], [0, 60]]);
  });

  it('includes a window that started before the horizon and is still running', () => {
    // Sunday 20:00 → Monday 07:00, asked for Monday 03:00 onwards.
    const from = local(2026, 10, 12, 3);
    const occ = expandWeeklySchedule([{ weekdays: [0], start: '20:00', end: '07:00', soc_percent: 60 }], from, from + 3600_000);
    expect(occ).toEqual([{ startMs: local(2026, 10, 11, 20), endMs: local(2026, 10, 12, 7), soc_percent: 60, ess_soc_percent: 100 }]);
  });

  it('treats start == end as a full 24 h window', () => {
    const occ = expandWeeklySchedule([{ weekdays: [3], start: '08:00', end: '08:00', soc_percent: 50 }], MON_NOON, MON_NOON + WEEK_MS);
    expect(occ[0].endMs - occ[0].startMs).toBe(24 * 3600_000);
  });

  it('merges overlapping windows, keeping the later end and the stricter target', () => {
    const occ = expandWeeklySchedule(
      [
        { weekdays: [3], start: '18:00', end: '23:00', soc_percent: 90 },
        { weekdays: [3], start: '20:00', end: '22:00', soc_percent: 70 },
      ],
      MON_NOON,
      MON_NOON + WEEK_MS,
    );
    expect(occ).toEqual([{ startMs: local(2026, 10, 14, 18), endMs: local(2026, 10, 14, 23), soc_percent: 90, ess_soc_percent: 100 }]);
  });

  it('is empty for an empty schedule or empty range', () => {
    expect(expandWeeklySchedule([], MON_NOON, MON_NOON + WEEK_MS)).toEqual([]);
    expect(expandWeeklySchedule([{ weekdays: [3], start: '18:00', end: '07:00', soc_percent: 80 }], MON_NOON, MON_NOON)).toEqual([]);
  });
});

describe('weeklyScheduleEntries', () => {
  it('emits a future arrival and a departure carrying the target', () => {
    const start = local(2026, 10, 14, 18);
    const end = local(2026, 10, 15, 7);
    const entries = weeklyScheduleEntries([{ startMs: start, endMs: end, soc_percent: 80, ess_soc_percent: 100 }], MON_NOON);
    expect(entries.map((e) => [e.type, e.time, e.soc_percent])).toEqual([
      ['arrival', new Date(start).toISOString(), undefined],
      ['departure', new Date(end).toISOString(), 80],
    ]);
  });

  it('skips the arrival of an ongoing window and drops finished ones', () => {
    const entries = weeklyScheduleEntries(
      [
        { startMs: MON_NOON - 7200_000, endMs: MON_NOON - 3600_000, soc_percent: 50, ess_soc_percent: 100 },
        { startMs: MON_NOON - 3600_000, endMs: MON_NOON + 3600_000, soc_percent: 70, ess_soc_percent: 100 },
      ],
      MON_NOON,
    );
    expect(entries.map((e) => e.type)).toEqual(['departure']);
    expect(entries[0].soc_percent).toBe(70);
  });
});
