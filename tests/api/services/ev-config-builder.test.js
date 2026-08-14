import { describe, it, expect } from 'vitest';
import { buildEvConfig } from '../../../api/services/ev-config-builder.ts';

const NOW_MS = new Date('2024-01-01T12:00:00Z').getTime();
const T = 96; // 24 h of 15-min slots

// Settings now only carry the static EV config; arrival/departure/target come from entries.
const base = {
  stepSize_m: 15,
  evEnabled: true,
  evMinChargeCurrent_A: 6,
  evMaxChargeCurrent_A: 16,
  evBatteryCapacity_kWh: 60,
  evChargeEfficiency_percent: 100,
  evTripSocBuffer_percent: 20,
};

const pluggedIn = { pluggedIn: true, soc_percent: 50 };

let seq = 0;
const entry = (type, time, soc_percent) => ({
  id: `e${seq++}`,
  type,
  time,
  ...(soc_percent != null ? { soc_percent } : {}),
  createdAt: time,
  updatedAt: time,
});

// Times relative to NOW (12:00): 13:00 = 4 slots, 14:00 = 8 slots, 15:00 = 12, 16:00 = 16.
const T13 = '2024-01-01T13:00:00Z';
const T14 = '2024-01-01T14:00:00Z';
const T15 = '2024-01-01T15:00:00Z';
const T16 = '2024-01-01T16:00:00Z';

describe('buildEvConfig — gating', () => {
  it('returns undefined when evEnabled is false', () => {
    expect(buildEvConfig({ ...base, evEnabled: false }, [], pluggedIn, NOW_MS, T)).toBeUndefined();
  });

  it('returns undefined when away with no arrival entry', () => {
    expect(buildEvConfig(base, [], { pluggedIn: false, soc_percent: 50 }, NOW_MS, T)).toBeUndefined();
  });

  it('returns undefined when away with an arrival but no SoC available', () => {
    const entries = [entry('arrival', T13)];
    expect(buildEvConfig(base, entries, { pluggedIn: false, soc_percent: NaN }, NOW_MS, T)).toBeUndefined();
  });
});

describe('buildEvConfig — availability windows', () => {
  it('is available the whole horizon when plugged in with no entries', () => {
    const ev = buildEvConfig(base, [], pluggedIn, NOW_MS, T);
    expect(ev.availabilityWindows).toEqual([{ startSlot: 0, endSlot: T, resetSoc_Wh: 30000 }]);
    expect(ev.targets).toEqual([]);
  });

  it('ends availability at a departure', () => {
    const ev = buildEvConfig(base, [entry('departure', T14)], pluggedIn, NOW_MS, T);
    expect(ev.availabilityWindows).toEqual([{ startSlot: 0, endSlot: 8, resetSoc_Wh: 30000 }]);
  });

  it('splits into two windows for a plugged-in leave and return', () => {
    const entries = [entry('departure', T14), entry('arrival', T16)];
    const ev = buildEvConfig(base, entries, pluggedIn, NOW_MS, T);
    expect(ev.availabilityWindows).toEqual([
      { startSlot: 0, endSlot: 8, resetSoc_Wh: 30000 },
      { startSlot: 16, endSlot: T, resetSoc_Wh: 30000 }, // no arrival SoC → current SoC
    ]);
  });

  it('uses the arrival entry SoC as the returning window reset', () => {
    const entries = [entry('departure', T14), entry('arrival', T16, 20)];
    const ev = buildEvConfig(base, entries, pluggedIn, NOW_MS, T);
    expect(ev.availabilityWindows[1]).toEqual({ startSlot: 16, endSlot: T, resetSoc_Wh: 12000 });
  });

  it('starts the window at the arrival slot when away, using the arrival SoC', () => {
    const ev = buildEvConfig(base, [entry('arrival', T13, 20)], { pluggedIn: false, soc_percent: 50 }, NOW_MS, T);
    expect(ev.availabilityWindows).toEqual([{ startSlot: 4, endSlot: T, resetSoc_Wh: 12000 }]);
    expect(ev.evInitialSoc_percent).toBe(20);
  });

  it('builds N windows from alternating entries (order-independent)', () => {
    // plugged in; leave 13:00, return 14:00, leave 15:00 → windows [0,4) and [8,12).
    const entries = [entry('departure', T15), entry('arrival', T14), entry('departure', T13)];
    const ev = buildEvConfig(base, entries, pluggedIn, NOW_MS, T);
    expect(ev.availabilityWindows.map(w => [w.startSlot, w.endSlot])).toEqual([[0, 4], [8, 12]]);
  });

  it('ignores an arrival while already available (no-op)', () => {
    const ev = buildEvConfig(base, [entry('arrival', T14)], pluggedIn, NOW_MS, T);
    expect(ev.availabilityWindows).toEqual([{ startSlot: 0, endSlot: T, resetSoc_Wh: 30000 }]);
  });

  it('ignores a departure while away, and uses the later arrival', () => {
    // away; a stray departure at 13:00 then arrival at 14:00 → single window [8, T).
    const entries = [entry('departure', T13), entry('arrival', T14, 30)];
    const ev = buildEvConfig(base, entries, { pluggedIn: false, soc_percent: 50 }, NOW_MS, T);
    expect(ev.availabilityWindows).toEqual([{ startSlot: 8, endSlot: T, resetSoc_Wh: 18000 }]);
  });

  it('ignores entries beyond the horizon', () => {
    const ev = buildEvConfig(base, [entry('arrival', '2030-01-01T00:00:00Z')], pluggedIn, NOW_MS, T);
    expect(ev.availabilityWindows).toEqual([{ startSlot: 0, endSlot: T, resetSoc_Wh: 30000 }]);
  });
});

describe('buildEvConfig — targets', () => {
  it('adds a clamped target for a departure with a SoC', () => {
    const ev = buildEvConfig(base, [entry('departure', T14, 80)], pluggedIn, NOW_MS, T);
    // 8 slots × 920 Wh = 7360; achievable = min(48000, 37360, 60000) = 37360 at slot 7.
    expect(ev.targets).toEqual([{ slot: 7, soc_Wh: 37360 }]);
  });

  it('adds a standalone target without ending availability', () => {
    const ev = buildEvConfig(base, [entry('target', T14, 80)], pluggedIn, NOW_MS, T);
    expect(ev.availabilityWindows[0].endSlot).toBe(T);
    expect(ev.targets).toEqual([{ slot: 7, soc_Wh: 37360 }]);
  });

  it('clamps a target deadline that falls after a departure', () => {
    const entries = [entry('departure', T13), entry('target', T14, 80)];
    const ev = buildEvConfig(base, entries, pluggedIn, NOW_MS, T);
    expect(ev.targets.length).toBe(1);
    expect(ev.targets[0].slot).toBe(3); // clamped to the departure window end (boundary 4)
  });

  it('keeps a departure target and a standalone target as two entries', () => {
    const entries = [entry('departure', T14, 80), entry('target', T13, 55)];
    const ev = buildEvConfig(base, entries, pluggedIn, NOW_MS, T);
    // standalone 55% by 13:00 (4 slots): min(33000, 30000+3680) = 33000 at slot 3; departure at slot 7.
    expect(ev.targets).toEqual([
      { slot: 3, soc_Wh: 33000 },
      { slot: 7, soc_Wh: 37360 },
    ]);
  });

  it('emits no targets when none are configured', () => {
    const ev = buildEvConfig(base, [entry('departure', T14)], pluggedIn, NOW_MS, T);
    expect(ev.targets).toEqual([]);
  });
});

describe('buildEvConfig — trips', () => {
  const trip = (time, endTime, usage_percent) => ({
    id: `t${seq++}`,
    type: 'trip',
    time,
    endTime,
    ...(usage_percent != null ? { usage_percent } : {}),
    createdAt: time,
    updatedAt: time,
  });

  it('splits into a reset window and a drop window (usage stays relative to departure SoC)', () => {
    const ev = buildEvConfig(base, [trip(T14, T16, 20)], pluggedIn, NOW_MS, T);
    expect(ev.availabilityWindows).toEqual([
      { startSlot: 0, endSlot: 8, resetSoc_Wh: 30000 },
      { startSlot: 16, endSlot: T, drop_Wh: 12000 }, // 20% of 60 kWh, no fixed reset
    ]);
  });

  it('derives a departure target of usage + buffer', () => {
    // usage 60% + buffer 20% = 80% (48 000 Wh), clamped to what 8 slots can charge:
    // 30 000 + 8 × 920 = 37 360 Wh, pinned at the slot before departure.
    const ev = buildEvConfig(base, [trip(T14, T16, 60)], pluggedIn, NOW_MS, T);
    expect(ev.targets).toEqual([{ slot: 7, soc_Wh: 37360 }]);
  });

  it('caps the derived target at 100%', () => {
    const ev = buildEvConfig({ ...base, evMaxChargeCurrent_A: 320 }, [trip(T14, T16, 90)], pluggedIn, NOW_MS, T);
    // 90 + 20 → clamped to 100% = 60 000 Wh (capacity), reachable with the inflated charger.
    expect(ev.targets).toEqual([{ slot: 7, soc_Wh: 60000 }]);
  });

  it('derives no target when the trip has no usage estimate, and chains the window', () => {
    const ev = buildEvConfig(base, [trip(T14, T16)], pluggedIn, NOW_MS, T);
    expect(ev.targets).toEqual([]);
    expect(ev.availabilityWindows[1]).toEqual({ startSlot: 16, endSlot: T }); // neither reset nor drop
  });

  it('clamps the drop to the maximum SoC reachable by departure (keeps the LP feasible)', () => {
    // 10% initial (6 000 Wh) + 4 slots × 920 Wh = 9 680 Wh max at departure < 50% usage (30 000).
    const ev = buildEvConfig(base, [trip(T13, T16, 50)], { pluggedIn: true, soc_percent: 10 }, NOW_MS, T);
    expect(ev.availabilityWindows[1].drop_Wh).toBe(9680);
  });

  it('keeps a post-trip target even below the pre-trip SoC (no fixed floor after a drop)', () => {
    // Target 30% at 17:00 (slot 20) sits in the drop window; with a fixed-reset window this
    // would be skipped as redundant, but after a trip the floor depends on solver decisions.
    const entries = [trip(T14, T16, 20), entry('target', '2024-01-01T17:00:00Z', 30)];
    const ev = buildEvConfig(base, entries, pluggedIn, NOW_MS, T);
    expect(ev.targets).toContainEqual({ slot: 19, soc_Wh: 18000 });
  });

  it('drops only the departure when the arrival lies beyond the horizon', () => {
    const ev = buildEvConfig(base, [trip(T14, '2030-01-01T00:00:00Z', 60)], pluggedIn, NOW_MS, T);
    expect(ev.availabilityWindows).toEqual([{ startSlot: 0, endSlot: 8, resetSoc_Wh: 30000 }]);
    expect(ev.targets).toEqual([{ slot: 7, soc_Wh: 37360 }]); // 60 + 20 → 80%, achievability-clamped
  });

  it('skips a derived target already below the departure-window reset', () => {
    // usage 20% + buffer 20% = 40% < the 50% the car already holds → redundant, no constraint.
    const ev = buildEvConfig(base, [trip(T14, T16, 20)], pluggedIn, NOW_MS, T);
    expect(ev.targets).toEqual([]);
  });
});

describe('buildEvConfig — overdue entries', () => {
  it('treats an overdue departure as departing at the next slot, target pinned to slot 0', () => {
    // Normalization keeps a past-due departure only while the car is still plugged in; the
    // builder must keep charging toward its target rather than dropping it.
    const past = entry('departure', '2024-01-01T09:00:00Z', 80);
    const ev = buildEvConfig(base, [past], pluggedIn, NOW_MS, T);
    expect(ev.availabilityWindows).toEqual([{ startSlot: 0, endSlot: 1, resetSoc_Wh: 30000 }]);
    expect(ev.targets).toEqual([{ slot: 0, soc_Wh: 30920 }]); // one slot of charging above 50%
  });

  it('treats an overdue arrival as arriving at the next slot while away', () => {
    const past = entry('arrival', '2024-01-01T09:00:00Z', 40);
    const ev = buildEvConfig(base, [past], { pluggedIn: false, soc_percent: NaN }, NOW_MS, T);
    expect(ev.availabilityWindows).toEqual([{ startSlot: 1, endSlot: T, resetSoc_Wh: 24000 }]);
  });
});

describe('buildEvConfig — multi-day horizon', () => {
  it('activates a target beyond the standard horizon once T covers it', () => {
    // Target 3 days out (2024-01-04 12:00 = slot 288 from 2024-01-01 12:00).
    const entries = [entry('target', '2024-01-04T12:00:00Z', 80)];

    // Standard 24 h horizon: beyond T → ignored (but persisted upstream).
    const standard = buildEvConfig(base, entries, pluggedIn, NOW_MS, 96);
    expect(standard.targets).toEqual([]);

    // 4-day horizon: the same entry becomes a real deadline, no re-staging needed.
    const extended = buildEvConfig(base, entries, pluggedIn, NOW_MS, 384);
    expect(extended.targets).toEqual([{ slot: 287, soc_Wh: 48000 }]);
  });
});
