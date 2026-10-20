import { describe, it, expect } from 'vitest';
import { applyEssFloorGuard } from '../../../api/services/ev-ess-floor.ts';

const decision = (over = {}) => ({
  ev_charge_W: 3680,
  ev_charge_A: 16,
  ev_charge_mode: 'max',
  g2ev_W: 2000,
  pv2ev_W: 1000,
  b2ev_W: 680,
  ...over,
});

describe('applyEssFloorGuard', () => {
  it('passes the decision through when the floor is disabled or not reached', () => {
    expect(applyEssFloorGuard(decision(), 10, 0)).toEqual({ ...decision(), ess_floor_active: false });
    expect(applyEssFloorGuard(decision(), 40, 30)).toEqual({ ...decision(), ess_floor_active: false });
    expect(applyEssFloorGuard(decision(), undefined, 30)).toEqual({ ...decision(), ess_floor_active: false });
  });

  it('downgrades grid/battery charging to solar_only below the floor', () => {
    expect(applyEssFloorGuard(decision(), 25, 30)).toEqual({
      ev_charge_W: 1000,
      ev_charge_A: 4.348,
      ev_charge_mode: 'solar_only',
      g2ev_W: 0,
      pv2ev_W: 1000,
      b2ev_W: 0,
      ess_floor_active: true,
    });
  });

  it('keeps grid charging and drops only the battery share when the grid is allowed', () => {
    expect(applyEssFloorGuard(decision(), 30, 50, true)).toEqual({
      ...decision(),
      ev_charge_W: 3000,
      ev_charge_A: 13.043,
      b2ev_W: 0,
      ess_floor_active: true,
    });
  });

  it('leaves PV-only and off decisions untouched but flags the floor', () => {
    const pvOnly = decision({ ev_charge_mode: 'solar_only', ev_charge_W: 1500, g2ev_W: 0, b2ev_W: 0, pv2ev_W: 1500 });
    expect(applyEssFloorGuard(pvOnly, 10, 30)).toEqual({ ...pvOnly, ess_floor_active: true });
    const off = decision({ ev_charge_mode: 'off', ev_charge_W: 0, g2ev_W: 0, b2ev_W: 0, pv2ev_W: 0 });
    expect(applyEssFloorGuard(off, 10, 30)).toEqual({ ...off, ess_floor_active: true });
  });
});
