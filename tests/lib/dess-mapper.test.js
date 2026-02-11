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
      // Row 0: grid usage at high price (50), soc at max boundary (100%)
      // Row 1: no flow, medium price (30), mid-range SoC
      // With segmentation: row 0 at max SoC boundary creates a segment break.
      // Row 1 is in its own segment with no grid usage, tipping point = -Infinity,
      // and ic(30) > -Infinity -> selfConsumption.
      //
      // Without segmentation: row 1 would share a segment with row 0, see its
      // high-price (50) grid usage as tipping point, and ic(30) <= 50 -> proBattery.
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

describe('Tipping Point Calculations', () => {
  // Minimal mock of the config
  const mockCfg = {
    stepSize_m: 15,
    minSoc_percent: 10,
    maxSoc_percent: 90,
    maxChargePower_W: 1000,
    maxDischargePower_W: 1000,
    maxGridImport_W: 5000,
    maxGridExport_W: 5000,
  };

  // Helper to create a row with specific values
  function createRow({
    soc_percent = 50,
    g2b = 0, // Grid to Battery
    b2g = 0, // Battery to Grid
    ic = 0,  // Import Cost
    ec = 0,  // Export Cost (Revenue)
  } = {}) {
    return {
      soc_percent,
      g2b,
      b2g,
      ic,
      ec,
      // defaults for others to avoid crashes
      g2l: 0, pv2l: 0, pv2b: 0, pv2g: 0, b2l: 0,
      load: 0, pv: 0, soc: 0
    };
  }

  it('should calculate Grid Charge Tipping Point correctly', () => {
    const rows = [
      createRow({ soc_percent: 50, g2b: 100, ic: 10 }), // Charge at 10c
      createRow({ soc_percent: 50, g2b: 100, ic: 15 }), // Charge at 15c
      createRow({ soc_percent: 50, g2b: 0, ic: 20 }), // No charge at 20c
      createRow({ soc_percent: 50, g2b: 100, ic: 12 }), // Charge at 12c
    ];

    const result = mapRowsToDess(rows, mockCfg);
    // The highest price at which we charged was 15c
    expect(result.diagnostics.gridChargeTippingPoint_cents_per_kWh).toBe(15);
  });

  it('should return null for Grid Charge Tipping Point if no charging occurs', () => {
    const rows = [
      createRow({ soc_percent: 50, g2b: 0, ic: 10 }),
      createRow({ soc_percent: 50, g2b: 0, ic: 15 }),
    ];

    const result = mapRowsToDess(rows, mockCfg);
    expect(result.diagnostics.gridChargeTippingPoint_cents_per_kWh).toBeNull();
  });

  it('should calculate Battery Export Tipping Point correctly', () => {
    const rows = [
      createRow({ soc_percent: 50, b2g: 100, ec: 30 }), // Export at 30c
      createRow({ soc_percent: 50, b2g: 100, ec: 20 }), // Export at 20c
      createRow({ soc_percent: 50, b2g: 0, ec: 10 }), // No export at 10c
      createRow({ soc_percent: 50, b2g: 100, ec: 25 }), // Export at 25c
    ];

    const result = mapRowsToDess(rows, mockCfg);
    // The lowest price at which we exported was 20c
    expect(result.diagnostics.batteryExportTippingPoint_cents_per_kWh).toBe(20);
  });

  it('should return null for Battery Export Tipping Point if no exporting occurs', () => {
    const rows = [
      createRow({ soc_percent: 50, b2g: 0, ec: 30 }),
      createRow({ soc_percent: 50, b2g: 0, ec: 20 }),
    ];

    const result = mapRowsToDess(rows, mockCfg);
    expect(result.diagnostics.batteryExportTippingPoint_cents_per_kWh).toBeNull();
  });

  it('should ignore small flows (epsilon)', () => {
    const rows = [
      // g2b=0.5 is <= FLOW_EPSILON_W (1), should be ignored
      createRow({ soc_percent: 50, g2b: 0.5, ic: 100 }),
      createRow({ soc_percent: 50, g2b: 100, ic: 10 }),
    ];

    const result = mapRowsToDess(rows, mockCfg);
    expect(result.diagnostics.gridChargeTippingPoint_cents_per_kWh).toBe(10);
  });

  it('should only search within the first SoC segment', () => {
    // If the planner reaches min/max SoC, it starts a new segment.
    // We only care about the immediate future (first segment).

    const rows = [
      createRow({ soc_percent: 50, g2b: 100, ic: 10 }), // Segment 1
      createRow({ soc_percent: 10, g2b: 100, ic: 10 }), // Boundary (minSoc) -> Start Segment 2 next?
      // Actually dess-mapper logic: if isAtSocBoundary, current index ends segment.
      // So index 1 is end of segment 1.

      createRow({ soc_percent: 50, g2b: 100, ic: 99 }), // Segment 2
    ];

    // Note: mockCfg.minSoc_percent = 10. `isAtSocBoundary` checks <= min + epsilon.
    // So row 1 (10%) triggers boundary.
    // Segment 1 is index 0..1.
    // Segment 2 is index 2..2.

    // We expect it to find 10c from segment 1, NOT 99c from segment 2.
    const result = mapRowsToDess(rows, mockCfg);
    expect(result.diagnostics.gridChargeTippingPoint_cents_per_kWh).toBe(10);
  });
});
