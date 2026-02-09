import { describe, it, expect } from 'vitest';
import { mapRowsToDess, Strategy, Restrictions, FeedIn } from '../../lib/dess-mapper.js';

describe('mapRowsToDess', () => {
  const cfg = {
    maxGridImport_W: 5000,
    maxSoc_percent: 100,
    minSoc_percent: 0,
    maxDischargePower_W: 4000,
  };

  const baseRow = {
    g2l: 0, g2b: 0, pv2l: 0, pv2b: 0, pv2g: 0, b2l: 0, b2g: 0,
    soc: 500, soc_percent: 50,
    load: 500, pv: 0,
    ic: 10, ec: 5,
  };

  it('detects proBattery strategy when charging from grid', () => {
    const rows = [{
      ...baseRow,
      g2b: 1000, // Charging from grid
      load: 0,
    }];

    const { perSlot } = mapRowsToDess(rows, cfg);
    expect(perSlot[0].strategy).toBe(Strategy.proBattery);
  });

  it('detects proGrid strategy when discharging to grid', () => {
    const rows = [{
      ...baseRow,
      b2g: 1000, // Discharging to grid
      load: 0,
    }];

    const { perSlot } = mapRowsToDess(rows, cfg);
    expect(perSlot[0].strategy).toBe(Strategy.proGrid);
  });

  describe('Deficit scenarios (Load > PV)', () => {
    it('detects selfConsumption when battery covers deficit', () => {
      const rows = [{
        ...baseRow,
        load: 500, pv: 0,
        b2l: 500, g2l: 0,
      }];
      const { perSlot } = mapRowsToDess(rows, cfg);
      expect(perSlot[0].strategy).toBe(Strategy.selfConsumption);
    });

    it('detects proBattery when grid covers deficit', () => {
      const rows = [{
        ...baseRow,
        load: 500, pv: 0,
        b2l: 0, g2l: 500,
      }];
      const { perSlot } = mapRowsToDess(rows, cfg);
      expect(perSlot[0].strategy).toBe(Strategy.proBattery);
    });

    it('detects proBattery when mixed grid and battery covers deficit', () => {
        const rows = [{
            ...baseRow,
            load: 1000, pv: 0,
            b2l: 500, g2l: 500,
        }];
        const { perSlot } = mapRowsToDess(rows, cfg);
        expect(perSlot[0].strategy).toBe(Strategy.proBattery);
    });

    it('uses price signal when no flow (Price <= Tipping Point -> ProBattery)', () => {
        // We need 2 slots. Slot 0 defines tipping point (Grid usage at high price).
        // Slot 1 has no flow (load=pv=0) but low price.
        // Both will be in same segment because socTarget_percent is undefined.
        const rows = [
            {
                ...baseRow,
                g2l: 500, ic: 50, // High price grid usage
            },
            {
                ...baseRow,
                load: 0, pv: 0, ic: 10, // Low price, no flow
            }
        ];
        const { perSlot } = mapRowsToDess(rows, cfg);
        // Slot 1: ic(10) <= highest(50) -> proBattery
        expect(perSlot[1].strategy).toBe(Strategy.proBattery);
    });

    it('uses price signal when no flow (Price > Tipping Point -> SelfConsumption)', () => {
        const rows = [
            {
                ...baseRow,
                g2l: 500, ic: 10, // Low price grid usage
            },
            {
                ...baseRow,
                load: 0, pv: 0, ic: 50, // High price
            }
        ];
        const { perSlot } = mapRowsToDess(rows, cfg);
        expect(perSlot[1].strategy).toBe(Strategy.selfConsumption);
    });
  });

  describe('PV Surplus scenarios (PV > Load)', () => {
    it('detects proGrid when exporting surplus', () => {
        const rows = [{
            ...baseRow,
            load: 0, pv: 500,
            pv2g: 500,
        }];
        const { perSlot } = mapRowsToDess(rows, cfg);
        expect(perSlot[0].strategy).toBe(Strategy.proGrid);
    });

    it('uses price signal when charging battery (Price <= Tipping Point -> ProBattery)', () => {
        const rows = [
            {
                ...baseRow,
                g2l: 500, ic: 50,
            },
            {
                ...baseRow,
                load: 0, pv: 500, pv2b: 500, ic: 10,
            }
        ];
        const { perSlot } = mapRowsToDess(rows, cfg);
        expect(perSlot[1].strategy).toBe(Strategy.proBattery);
    });

     it('uses price signal when charging battery (Price > Tipping Point -> SelfConsumption)', () => {
        const rows = [
            {
                ...baseRow,
                g2l: 500, ic: 10,
            },
            {
                ...baseRow,
                load: 0, pv: 500, pv2b: 500, ic: 50,
            }
        ];
        const { perSlot } = mapRowsToDess(rows, cfg);
        expect(perSlot[1].strategy).toBe(Strategy.selfConsumption);
    });
  });

  describe('Restrictions', () => {
    it('allows none when both charging and discharging happen', () => {
      const rows = [{ ...baseRow, g2b: 100, b2g: 100 }];
      const { perSlot } = mapRowsToDess(rows, cfg);
      expect(perSlot[0].restrictions).toBe(Restrictions.none);
    });

    it('blocks B2G when only charging', () => {
      const rows = [{ ...baseRow, g2b: 100, b2g: 0 }];
      const { perSlot } = mapRowsToDess(rows, cfg);
      expect(perSlot[0].restrictions).toBe(Restrictions.batteryToGrid);
    });

    it('blocks G2B when only discharging', () => {
      const rows = [{ ...baseRow, g2b: 0, b2g: 100 }];
      const { perSlot } = mapRowsToDess(rows, cfg);
      expect(perSlot[0].restrictions).toBe(Restrictions.gridToBattery);
    });

    it('blocks both when no interaction', () => {
      const rows = [{ ...baseRow, g2b: 0, b2g: 0 }];
      const { perSlot } = mapRowsToDess(rows, cfg);
      expect(perSlot[0].restrictions).toBe(Restrictions.both);
    });
  });

  describe('FeedIn', () => {
    it('blocks feed-in when export price is negative', () => {
      const rows = [{ ...baseRow, ec: -1 }];
      const { perSlot } = mapRowsToDess(rows, cfg);
      expect(perSlot[0].feedin).toBe(FeedIn.blocked);
    });

    it('allows feed-in when export price is positive', () => {
      const rows = [{ ...baseRow, ec: 1 }];
      const { perSlot } = mapRowsToDess(rows, cfg);
      expect(perSlot[0].feedin).toBe(FeedIn.allowed);
    });
  });

  describe('Segmentation', () => {
    it('creates a segment boundary at max SoC so price lookups are scoped', () => {
      // Row 0: grid usage at low price, soc at max boundary (100%)
      // Row 1: no flow, high price, mid-range SoC
      // Without segmentation, row 1 would see row 0's grid usage at price 10
      // as tipping point, and ic(50) > 10 -> selfConsumption.
      // With segmentation, row 0 is at max SoC boundary -> segment break.
      // Row 1 is in its own segment with no grid usage, tipping point = -Infinity,
      // and ic(50) > -Infinity -> selfConsumption either way.
      //
      // Instead, verify the opposite: row 0 at boundary scopes row 1 away from
      // row 0's high-price grid usage that would otherwise set a high tipping point.
      const rows = [
        {
          ...baseRow,
          g2l: 500, ic: 50, soc_percent: 100, // at max boundary, high price grid usage
        },
        {
          ...baseRow,
          load: 0, pv: 0, ic: 30, soc_percent: 50, // mid-range SoC
        },
      ];
      const { perSlot } = mapRowsToDess(rows, cfg);
      // Row 1 is in a separate segment (no grid usage there),
      // tipping point = -Infinity, ic(30) > -Infinity -> selfConsumption
      expect(perSlot[1].strategy).toBe(Strategy.selfConsumption);

      // Now verify that WITHOUT the boundary (mid-range SoC on row 0),
      // both rows share a segment and row 1 gets proBattery instead
      const rowsNoBoundary = [
        {
          ...baseRow,
          g2l: 500, ic: 50, soc_percent: 50, // NOT at boundary
        },
        {
          ...baseRow,
          load: 0, pv: 0, ic: 30, soc_percent: 50,
        },
      ];
      const { perSlot: perSlotNoBoundary } = mapRowsToDess(rowsNoBoundary, cfg);
      // Same segment: tipping point from row 0 is 50, ic(30) <= 50 -> proBattery
      expect(perSlotNoBoundary[1].strategy).toBe(Strategy.proBattery);
    });

    it('keeps rows in same segment when SoC is not at boundary', () => {
      // Both rows at mid-range SoC -> no segment break -> same segment
      const rows = [
        {
          ...baseRow,
          g2l: 500, ic: 10, soc_percent: 50,
        },
        {
          ...baseRow,
          load: 0, pv: 0, ic: 50, soc_percent: 50,
        },
      ];
      const { perSlot } = mapRowsToDess(rows, cfg);
      // Same segment: tipping point from row 0 is 10, row 1 ic(50) > 10 -> selfConsumption
      expect(perSlot[1].strategy).toBe(Strategy.selfConsumption);
    });
  });
});
