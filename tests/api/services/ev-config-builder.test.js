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
