import { describe, it, expect } from 'vitest';
import { batteryFloorsForFlows, chargeStretches, planCheapestSourceEv } from '../../lib/ev-cheapest-source.ts';

const T = 6;
// 1-hour slots, no losses: 1000 W for a slot is 1000 Wh on both sides.
const cfg = {
  stepSize_m: 60,
  batteryCapacity_Wh: 10000,
  initialSoc_percent: 80,
  minSoc_percent: 10,
  maxDischargePower_W: 4000,
  maxGridImport_W: 5000,
  dischargeEfficiency_percent: 100,
};
const ev = {
  evMinChargePower_W: 1000,
  evMaxChargePower_W: 3000,
  evBatteryCapacity_Wh: 60000,
  evInitialSoc_percent: 50,
  evChargeEfficiency_percent: 100,
  evMaxSoc_percent: 100,
  availabilityWindows: [{ startSlot: 0, endSlot: T }],
  targets: [{ slot: T - 1, soc_Wh: 48000 }],
  essSocFloor_Wh: 3000,
  essFloorGridPriceLimit_cents_per_kWh: 10,
};
const none = () => ({ g2ev: Array(T).fill(0), pv2ev: Array(T).fill(0), b2ev: Array(T).fill(0) });
// A house that leaves the battery alone at 8000 Wh.
const row = (over = {}) => ({ ic: 30, soc_Wh: 8000, imp: 0, pv2g: 0, b2l: 0, b2g: 0, ...over });
const plan = (rows, evOver = {}) => planCheapestSourceEv(rows, cfg, { ...ev, ...evOver }, none(), [0, T]);

describe('planCheapestSourceEv', () => {
  it('drains the battery down to the floor and then stops', () => {
    const flows = plan(Array.from({ length: T }, () => row()));
    // 5000 Wh above the floor: 3000 + 2000, then nothing (below the charger minimum).
    expect(flows.b2ev).toEqual([3000, 2000, 0, 0, 0, 0]);
    expect(flows.g2ev).toEqual(Array(T).fill(0));
  });

  it('takes grid power instead when it is under the price limit', () => {
    const rows = Array.from({ length: T }, (_, t) => row({ ic: t === 1 ? 5 : 30 }));
    const flows = plan(rows);
    expect(flows.g2ev).toEqual([0, 3000, 0, 0, 0, 0]);
    expect(flows.b2ev).toEqual([3000, 0, 2000, 0, 0, 0]);
  });

  it('leaves the house its share of the discharge power and stops at the EV ceiling', () => {
    const rows = Array.from({ length: T }, () => row({ b2l: 2500, soc_Wh: 9000 }));
    const flows = plan(rows, { targets: [{ slot: T - 1, soc_Wh: 32500 }] });
    // 4000 W limit minus 2500 W for the house leaves 1500 W; the EV needs 2500 Wh.
    expect(flows.b2ev).toEqual([1500, 1000, 0, 0, 0, 0]);
  });

  it('redirects battery export and exported PV to the EV', () => {
    const rows = Array.from({ length: T }, (_, t) => row({ soc_Wh: 3000, b2g: t === 0 ? 2000 : 0, pv2g: t === 2 ? 1200 : 0 }));
    const flows = plan(rows, { essSocFloor_Wh: 3000 });
    expect(flows.b2ev).toEqual([2000, 0, 0, 0, 0, 0]);
    expect(flows.pv2ev).toEqual([0, 0, 1200, 0, 0, 0]);
  });

  it('only decides its own stretch and starts from what earlier stretches charged', () => {
    const prior = { ...none(), g2ev: [3000, 3000, 0, 0, 0, 0] };
    const flows = planCheapestSourceEv(
      Array.from({ length: T }, () => row()),
      cfg,
      { ...ev, targets: [{ slot: T - 1, soc_Wh: 37500 }] },
      prior,
      [3, T],
    );
    // 30000 + 6000 already charged; 1500 Wh of room left.
    expect(flows.g2ev).toEqual(prior.g2ev);
    expect(flows.b2ev).toEqual([0, 0, 0, 1500, 0, 0]);
  });
});

describe('chargeStretches', () => {
  it('returns the runs of slots inside a window and the weekly mask', () => {
    expect(chargeStretches({
      availabilityWindows: [{ startSlot: 0, endSlot: 6 }],
      chargeAllowed: [false, true, true, false, false, true],
    }, 6)).toEqual([[1, 3], [5, 6]]);
  });
});

describe('batteryFloorsForFlows', () => {
  it('floors the slot the EV draws in and the one before', () => {
    expect(batteryFloorsForFlows([0, 0, 500, 500, 0], 3000)).toEqual([
      { slot: 1, soc_Wh: 3000 }, { slot: 2, soc_Wh: 3000 }, { slot: 3, soc_Wh: 3000 },
    ]);
  });
});
