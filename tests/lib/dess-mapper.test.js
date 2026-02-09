import { describe, it, expect } from 'vitest';
import { mapRowsToDess, Strategy, Restrictions, FeedIn } from '../../lib/dess-mapper.js';

describe('mapRowsToDess', () => {
  const cfg = {
    maxGridImport_W: 5000,
    maxSoc_percent: 100,
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

  describe('Diagnostics (tipping point)', () => {
    it('stops looking for tipping point when battery reaches max SoC', () => {
      // T=0: 50% SoC, Grid Usage, Price=10
      // T=1: 100% SoC, Grid Usage, Price=10 (Boundary!) -> Should end segment here
      // T=2: 100% SoC, Grid Usage, Price=100 -> Should be in next segment
      const rows = [
        { ...baseRow, soc_percent: 50, g2l: 100, ic: 10 },
        { ...baseRow, soc_percent: 100, g2l: 100, ic: 10 },
        { ...baseRow, soc_percent: 100, g2l: 100, ic: 100 },
      ];

      const { diagnostics } = mapRowsToDess(rows, cfg);
      // If segmented correctly: max price in first segment (T=0, T=1) is 10.
      // If not segmented (bug): max price is 100.
      expect(diagnostics.firstSegmentTippingPoint_cents_per_kWh).toBe(10);
    });
  });
});
