import { describe, it, expect } from 'vitest';
import {
  createEvScheduleEntry,
  updateEvScheduleEntry,
  normalizeEvScheduleEntries,
  recordEvLastState,
  validateEvScheduleEntry,
} from '../../../api/services/ev-schedule-entries.ts';

const NOW_MS = new Date('2024-01-01T12:00:00Z').getTime();
const FUTURE = '2024-01-01T14:00:00Z';
const FUTURE_LATER = '2024-01-01T18:00:00Z';
const PAST = '2024-01-01T10:00:00Z';
const PAST_EARLIER = '2024-01-01T08:00:00Z';

const lastState = (pluggedIn, soc_percent = null) =>
  ({ pluggedIn, soc_percent, observedAt: new Date(NOW_MS).toISOString() });

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

describe('createEvScheduleEntry — trips', () => {
  it('creates a trip with endTime and optional usage', () => {
    const e = createEvScheduleEntry({ type: 'trip', time: FUTURE, endTime: FUTURE_LATER, usage_percent: 25 }, NOW_MS);
    expect(e.type).toBe('trip');
    expect(e.time).toBe(new Date(FUTURE).toISOString());
    expect(e.endTime).toBe(new Date(FUTURE_LATER).toISOString());
    expect(e.usage_percent).toBe(25);
  });

  it('creates a trip without a usage estimate (omits the field)', () => {
    const e = createEvScheduleEntry({ type: 'trip', time: FUTURE, endTime: FUTURE_LATER }, NOW_MS);
    expect('usage_percent' in e).toBe(false);
  });

  it('requires endTime and rejects arrival at/before departure', () => {
    expect(() => createEvScheduleEntry({ type: 'trip', time: FUTURE }, NOW_MS)).toThrow();
    expect(() => createEvScheduleEntry({ type: 'trip', time: FUTURE, endTime: FUTURE }, NOW_MS)).toThrow();
    expect(() => createEvScheduleEntry({ type: 'trip', time: FUTURE, endTime: PAST }, NOW_MS)).toThrow();
  });

  it('rejects an out-of-range usage_percent', () => {
    expect(() => createEvScheduleEntry({ type: 'trip', time: FUTURE, endTime: FUTURE_LATER, usage_percent: 120 }, NOW_MS)).toThrow();
    expect(() => createEvScheduleEntry({ type: 'trip', time: FUTURE, endTime: FUTURE_LATER, usage_percent: -1 }, NOW_MS)).toThrow();
  });

  it('drops trip fields when an edit switches the type away from trip', () => {
    const trip = createEvScheduleEntry({ type: 'trip', time: FUTURE, endTime: FUTURE_LATER, usage_percent: 25 }, NOW_MS);
    const departure = updateEvScheduleEntry(trip, { type: 'departure' }, NOW_MS);
    expect('endTime' in departure).toBe(false);
    expect('usage_percent' in departure).toBe(false);
  });

  it('clears a previously-set usage_percent when passed null', () => {
    const trip = createEvScheduleEntry({ type: 'trip', time: FUTURE, endTime: FUTURE_LATER, usage_percent: 25 }, NOW_MS);
    const updated = updateEvScheduleEntry(trip, { usage_percent: null }, NOW_MS);
    expect('usage_percent' in updated).toBe(false);
    expect(updated.endTime).toBe(trip.endTime);
  });
});

describe('recordEvLastState', () => {
  it('records plug state and SoC while plugged in', () => {
    const data = recordEvLastState({}, { pluggedIn: true, soc_percent: 60 }, NOW_MS);
    expect(data.evLastState).toEqual(lastState(true, 60));
  });

  it('keeps the plugged-in SoC once the car leaves (away reading must not overwrite it)', () => {
    const plugged = recordEvLastState({}, { pluggedIn: true, soc_percent: 60 }, NOW_MS);
    const away = recordEvLastState(plugged, { pluggedIn: false, soc_percent: NaN }, NOW_MS + 1);
    expect(away.evLastState.pluggedIn).toBe(false);
    expect(away.evLastState.soc_percent).toBe(60);
  });

  it('returns the same object when nothing changed or no state is available', () => {
    const data = recordEvLastState({}, { pluggedIn: true, soc_percent: 60 }, NOW_MS);
    expect(recordEvLastState(data, { pluggedIn: true, soc_percent: 60 }, NOW_MS + 1)).toBe(data);
    expect(recordEvLastState(data, undefined, NOW_MS + 1)).toBe(data);
  });
});

describe('normalizeEvScheduleEntries — plug-state-aware pruning', () => {
  it('keeps an overdue departure while the car is still plugged in', () => {
    const overdue = createEvScheduleEntry({ type: 'departure', time: PAST }, NOW_MS - 10_000);
    const result = normalizeEvScheduleEntries({ evScheduleEntries: [overdue], evLastState: lastState(true, 50) }, NOW_MS);
    expect(result.changed).toBe(false);
    expect(result.entries).toEqual([overdue]);
  });

  it('drops a past departure once the car is gone', () => {
    const departed = createEvScheduleEntry({ type: 'departure', time: PAST }, NOW_MS - 10_000);
    const result = normalizeEvScheduleEntries({ evScheduleEntries: [departed], evLastState: lastState(false, 50) }, NOW_MS);
    expect(result.entries).toEqual([]);
  });

  it('keeps an overdue arrival while the car is still away', () => {
    const overdue = createEvScheduleEntry({ type: 'arrival', time: PAST, soc_percent: 40 }, NOW_MS - 10_000);
    const result = normalizeEvScheduleEntries({ evScheduleEntries: [overdue], evLastState: lastState(false, null) }, NOW_MS);
    expect(result.changed).toBe(false);
    expect(result.entries).toEqual([overdue]);
  });

  it('drops a past arrival once the car is back', () => {
    const arrived = createEvScheduleEntry({ type: 'arrival', time: PAST, soc_percent: 40 }, NOW_MS - 10_000);
    const result = normalizeEvScheduleEntries({ evScheduleEntries: [arrived], evLastState: lastState(true, 40) }, NOW_MS);
    expect(result.entries).toEqual([]);
  });

  it('always drops past targets', () => {
    const past = createEvScheduleEntry({ type: 'target', time: PAST, soc_percent: 80 }, NOW_MS - 10_000);
    const result = normalizeEvScheduleEntries({ evScheduleEntries: [past], evLastState: lastState(true, 50) }, NOW_MS);
    expect(result.entries).toEqual([]);
  });
});

describe('normalizeEvScheduleEntries — trip conversion', () => {
  const trip = (time, endTime, usage_percent) =>
    createEvScheduleEntry({ type: 'trip', time, endTime, ...(usage_percent != null ? { usage_percent } : {}) }, NOW_MS - 10_000);

  it('keeps a future trip untouched', () => {
    const future = trip(FUTURE, FUTURE_LATER, 25);
    const result = normalizeEvScheduleEntries({ evScheduleEntries: [future], evLastState: lastState(true, 60) }, NOW_MS);
    expect(result.changed).toBe(false);
    expect(result.entries).toEqual([future]);
  });

  it('keeps an overdue trip while the car is still plugged in', () => {
    const overdue = trip(PAST, FUTURE, 25);
    const result = normalizeEvScheduleEntries({ evScheduleEntries: [overdue], evLastState: lastState(true, 60) }, NOW_MS);
    expect(result.changed).toBe(false);
    expect(result.entries).toEqual([overdue]);
  });

  it('drops a trip whose arrival also passed while the car never left', () => {
    const stale = trip(PAST_EARLIER, PAST, 25);
    const result = normalizeEvScheduleEntries({ evScheduleEntries: [stale], evLastState: lastState(true, 60) }, NOW_MS);
    expect(result.entries).toEqual([]);
  });

  it('converts a departed trip into an arrival with SoC-at-unplug minus usage', () => {
    const departed = trip(PAST, FUTURE, 25);
    const result = normalizeEvScheduleEntries({ evScheduleEntries: [departed], evLastState: lastState(false, 60) }, NOW_MS);
    expect(result.changed).toBe(true);
    expect(result.entries).toEqual([{
      id: departed.id,
      type: 'arrival',
      time: new Date(FUTURE).toISOString(),
      soc_percent: 35,
      createdAt: departed.createdAt,
      updatedAt: new Date(NOW_MS).toISOString(),
    }]);
  });

  it('clamps the converted arrival SoC at 0', () => {
    const departed = trip(PAST, FUTURE, 80);
    const result = normalizeEvScheduleEntries({ evScheduleEntries: [departed], evLastState: lastState(false, 30) }, NOW_MS);
    expect(result.entries[0].soc_percent).toBe(0);
  });

  it('omits the SoC when usage or SoC-at-unplug is unknown (defers to the sensor)', () => {
    const noUsage = trip(PAST, FUTURE);
    const noSoc = trip(PAST, FUTURE_LATER, 25);
    const result = normalizeEvScheduleEntries(
      { evScheduleEntries: [noUsage, noSoc], evLastState: lastState(false, null) },
      NOW_MS,
    );
    expect(result.entries.map(e => e.type)).toEqual(['arrival', 'arrival']);
    expect(result.entries.some(e => 'soc_percent' in e)).toBe(false);
  });

  it('keeps a converted arrival whose time already passed while the car is still away', () => {
    const departed = trip(PAST_EARLIER, PAST, 25);
    const result = normalizeEvScheduleEntries({ evScheduleEntries: [departed], evLastState: lastState(false, 60) }, NOW_MS);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe('arrival');
    expect(result.entries[0].time).toBe(new Date(PAST).toISOString());
  });

  it('converts a past trip with no recorded plug state (assumed departed, no SoC estimate)', () => {
    const departed = trip(PAST, FUTURE, 25);
    const result = normalizeEvScheduleEntries({ evScheduleEntries: [departed] }, NOW_MS);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe('arrival');
    expect('soc_percent' in result.entries[0]).toBe(false);
  });
});

describe('normalizeEvScheduleEntries', () => {
  it('drops entries with time < now and keeps the rest', () => {
    const past = createEvScheduleEntry({ type: 'departure', time: PAST }, NOW_MS - 10_000);
    const future = createEvScheduleEntry({ type: 'arrival', time: FUTURE }, NOW_MS);
    const data = { evScheduleEntries: [past, future] };
    const result = normalizeEvScheduleEntries(data, NOW_MS);
    expect(result.changed).toBe(true);
    expect(result.entries).toEqual([future]);
  });

  it('reports no change when all entries are current', () => {
    const future = createEvScheduleEntry({ type: 'arrival', time: FUTURE }, NOW_MS);
    const result = normalizeEvScheduleEntries({ evScheduleEntries: [future] }, NOW_MS);
    expect(result.changed).toBe(false);
    expect(result.entries).toEqual([future]);
  });

  it('handles missing evScheduleEntries', () => {
    const result = normalizeEvScheduleEntries({}, NOW_MS);
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
