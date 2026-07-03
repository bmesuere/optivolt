import { describe, it, expect } from 'vitest';
import {
  createEvScheduleEntry,
  updateEvScheduleEntry,
  pruneExpiredEvScheduleEntries,
  validateEvScheduleEntry,
} from '../../../api/services/ev-schedule-entries.ts';

const NOW_MS = new Date('2024-01-01T12:00:00Z').getTime();
const FUTURE = '2024-01-01T14:00:00Z';
const PAST = '2024-01-01T10:00:00Z';

describe('createEvScheduleEntry — validation', () => {
  it('creates an arrival with optional SoC', () => {
    const e = createEvScheduleEntry({ type: 'arrival', time: FUTURE, soc_percent: 40 }, NOW_MS);
    expect(e.type).toBe('arrival');
    expect(e.time).toBe(new Date(FUTURE).toISOString());
    expect(e.soc_percent).toBe(40);
    expect(typeof e.id).toBe('string');
    expect(e.createdAt).toBe(new Date(NOW_MS).toISOString());
    expect(e.updatedAt).toBe(e.createdAt);
  });

  it('creates an arrival without a SoC (omits the field)', () => {
    const e = createEvScheduleEntry({ type: 'arrival', time: FUTURE }, NOW_MS);
    expect('soc_percent' in e).toBe(false);
  });

  it('creates a departure with an optional target SoC', () => {
    const e = createEvScheduleEntry({ type: 'departure', time: FUTURE, soc_percent: 80 }, NOW_MS);
    expect(e.type).toBe('departure');
    expect(e.soc_percent).toBe(80);
  });

  it('allows a past time (entries persist until pruned)', () => {
    const e = createEvScheduleEntry({ type: 'departure', time: PAST }, NOW_MS);
    expect(e.time).toBe(new Date(PAST).toISOString());
  });

  it('rejects an unknown type', () => {
    expect(() => createEvScheduleEntry({ type: 'leave', time: FUTURE }, NOW_MS)).toThrow();
  });

  it('rejects an unparseable time', () => {
    expect(() => createEvScheduleEntry({ type: 'arrival', time: 'not-a-date' }, NOW_MS)).toThrow();
  });

  it('requires soc_percent in [0,100] for a target', () => {
    expect(() => createEvScheduleEntry({ type: 'target', time: FUTURE }, NOW_MS)).toThrow();
    expect(() => createEvScheduleEntry({ type: 'target', time: FUTURE, soc_percent: 120 }, NOW_MS)).toThrow();
    const e = createEvScheduleEntry({ type: 'target', time: FUTURE, soc_percent: 90 }, NOW_MS);
    expect(e.soc_percent).toBe(90);
  });

  it('rejects an out-of-range optional SoC for arrival/departure', () => {
    expect(() => createEvScheduleEntry({ type: 'arrival', time: FUTURE, soc_percent: -5 }, NOW_MS)).toThrow();
    expect(() => createEvScheduleEntry({ type: 'departure', time: FUTURE, soc_percent: 150 }, NOW_MS)).toThrow();
  });
});

describe('updateEvScheduleEntry', () => {
  it('keeps id/createdAt and bumps updatedAt', () => {
    const created = createEvScheduleEntry({ type: 'arrival', time: FUTURE, soc_percent: 40 }, NOW_MS);
    const laterMs = NOW_MS + 60_000;
    const updated = updateEvScheduleEntry(created, { soc_percent: 55 }, laterMs);
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.soc_percent).toBe(55);
    expect(updated.updatedAt).toBe(new Date(laterMs).toISOString());
  });

  it('clears a previously-set soc_percent when passed null', () => {
    const created = createEvScheduleEntry({ type: 'arrival', time: FUTURE, soc_percent: 40 }, NOW_MS);
    const updated = updateEvScheduleEntry(created, { type: 'arrival', time: FUTURE, soc_percent: null }, NOW_MS);
    expect('soc_percent' in updated).toBe(false);
  });

  it('clears a previously-set soc_percent when passed an empty string', () => {
    const created = createEvScheduleEntry({ type: 'departure', time: FUTURE, soc_percent: 80 }, NOW_MS);
    const updated = updateEvScheduleEntry(created, { type: 'departure', time: FUTURE, soc_percent: '' }, NOW_MS);
    expect('soc_percent' in updated).toBe(false);
  });

  it('keeps the existing soc_percent when the field is absent', () => {
    const created = createEvScheduleEntry({ type: 'arrival', time: FUTURE, soc_percent: 40 }, NOW_MS);
    const updated = updateEvScheduleEntry(created, { type: 'arrival', time: FUTURE }, NOW_MS);
    expect(updated.soc_percent).toBe(40);
  });
});

describe('pruneExpiredEvScheduleEntries', () => {
  it('drops entries with time < now and keeps the rest', () => {
    const past = createEvScheduleEntry({ type: 'departure', time: PAST }, NOW_MS - 10_000);
    const future = createEvScheduleEntry({ type: 'arrival', time: FUTURE }, NOW_MS);
    const data = { evScheduleEntries: [past, future] };
    const result = pruneExpiredEvScheduleEntries(data, NOW_MS);
    expect(result.changed).toBe(true);
    expect(result.entries).toEqual([future]);
  });

  it('reports no change when all entries are current', () => {
    const future = createEvScheduleEntry({ type: 'arrival', time: FUTURE }, NOW_MS);
    const result = pruneExpiredEvScheduleEntries({ evScheduleEntries: [future] }, NOW_MS);
    expect(result.changed).toBe(false);
    expect(result.entries).toEqual([future]);
  });

  it('handles missing evScheduleEntries', () => {
    const result = pruneExpiredEvScheduleEntries({}, NOW_MS);
    expect(result.changed).toBe(false);
    expect(result.entries).toEqual([]);
  });
});

describe('validateEvScheduleEntry', () => {
  it('accepts a well-formed entry', () => {
    const e = createEvScheduleEntry({ type: 'target', time: FUTURE, soc_percent: 80 }, NOW_MS);
    expect(() => validateEvScheduleEntry(e)).not.toThrow();
  });

  it('rejects a malformed entry', () => {
    expect(() => validateEvScheduleEntry({ id: '', type: 'arrival', time: FUTURE, createdAt: FUTURE, updatedAt: FUTURE })).toThrow();
  });
});
