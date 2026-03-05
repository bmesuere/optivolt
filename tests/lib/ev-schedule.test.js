import { describe, it, expect } from 'vitest';
import { buildEvSchedule } from '../../lib/ev-schedule.ts';

function makeRow(overrides = {}) {
  return {
    tIdx: 0,
    timestampMs: 1704067200000,
    load: 500,
    pv: 2000,
    ic: 25,
    ec: 10,
    g2l: 0,
    g2b: 0,
    pv2l: 500,
    pv2b: 0,
    pv2g: 0,
    b2l: 0,
    b2g: 0,
    imp: 0,
    exp: 0,
    soc: 10000,
    soc_percent: 50,
    dess: { feedin: 0, restrictions: 0, strategy: 0, flags: 0, socTarget_percent: 50 },
    ...overrides,
  };
}

const BASE_EV = { evEnabled: true, plugged: true, chargePower_W: 11000 };

describe('buildEvSchedule', () => {
  it('returns all false when EV is disabled', () => {
    const rows = [makeRow({ pv2g: 500 }), makeRow({ pv2g: 2000 })];
    const result = buildEvSchedule(rows, { ...BASE_EV, evEnabled: false });
    expect(result.every((s) => !s.shouldCharge)).toBe(true);
    expect(result.every((s) => s.chargePower_W === 0)).toBe(true);
  });

  it('returns all false when EV is not plugged', () => {
    const rows = [makeRow({ pv2g: 500 }), makeRow({ pv2g: 2000 })];
    const result = buildEvSchedule(rows, { ...BASE_EV, plugged: false });
    expect(result.every((s) => !s.shouldCharge)).toBe(true);
  });

  it('returns all false when there is no PV export', () => {
    const rows = [makeRow({ pv2g: 0 }), makeRow({ pv2g: 0.5 })];
    const result = buildEvSchedule(rows, BASE_EV);
    expect(result.every((s) => !s.shouldCharge)).toBe(true);
  });

  it('charges slots with pv2g > 1W', () => {
    const rows = [makeRow({ pv2g: 0 }), makeRow({ pv2g: 1500 }), makeRow({ pv2g: 0 })];
    const result = buildEvSchedule(rows, BASE_EV);
    expect(result[0].shouldCharge).toBe(false);
    expect(result[1].shouldCharge).toBe(true);
    expect(result[1].chargePower_W).toBe(11000);
    expect(result[2].shouldCharge).toBe(false);
  });

  it('does not trigger charging on battery-to-grid only (b2g > 0, pv2g = 0)', () => {
    const rows = [makeRow({ b2g: 3000, pv2g: 0 })];
    const result = buildEvSchedule(rows, BASE_EV);
    expect(result[0].shouldCharge).toBe(false);
  });

  it('output array length matches input rows', () => {
    const rows = Array.from({ length: 96 }, (_, i) => makeRow({ tIdx: i, pv2g: i % 2 === 0 ? 1500 : 0 }));
    const result = buildEvSchedule(rows, BASE_EV);
    expect(result).toHaveLength(96);
  });

  it('propagates timestamps from PlanRow', () => {
    const rows = [
      makeRow({ timestampMs: 1704067200000 }),
      makeRow({ timestampMs: 1704068100000 }),
    ];
    const result = buildEvSchedule(rows, BASE_EV);
    expect(result[0].timestampMs).toBe(1704067200000);
    expect(result[1].timestampMs).toBe(1704068100000);
  });

  it('tiny pv2g below threshold (0.5W) does not trigger charging', () => {
    const rows = [makeRow({ pv2g: 0.5 })];
    const result = buildEvSchedule(rows, BASE_EV);
    expect(result[0].shouldCharge).toBe(false);
  });

  it('pv2g exactly at threshold (1W) does not trigger charging', () => {
    const rows = [makeRow({ pv2g: 1 })];
    const result = buildEvSchedule(rows, BASE_EV);
    expect(result[0].shouldCharge).toBe(false);
  });
});
