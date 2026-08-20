// Mapper that attaches DESS decisions per slot.
// Assumes a complete, valid cfg is provided.

import type { PlanRow, SolverConfig, DessDiagnostics, DessResult, DessSlot } from './types.ts';

const FLOW_EPSILON_W = 1; // treat flows below this as zero
const SOC_EPSILON_PERCENT = 0.5; // treat SoC within this of min/max as at boundary

export const Strategy = {
  targetSoc: 0,       // excess PV and load to/from grid
  selfConsumption: 1, // excess PV and load to/from battery
  proBattery: 2,      // excess PV to battery, excess load from grid
  proGrid: 3,         // excess PV to grid, excess load from battery
  unknown: -1,
} as const;

export const Restrictions = {
  none: 0,            // no restrictions between battery and grid
  batteryToGrid: 1,   // restrict battery → grid
  gridToBattery: 2,   // restrict grid → battery
  both: 3,            // block both directions
  unknown: -1,
} as const;

export const FeedIn = {
  allowed: 1,
  blocked: 0,
} as const;

interface Segment {
  start: number;
  end: number;
}

interface SegmentTippingPoints {
  gridChargeTp: number;
  gridBatteryTp: number;
  batteryExportTp: number;
  pvExportTp: number;
}

export interface DessMapperOptions {
  blockFeedInOnNegativePrices?: boolean;
  rebalanceWindow?: {
    startIdx: number;
    endIdx: number;
  };
}

function feedInForRow(row: PlanRow, options: DessMapperOptions): number {
  return options.blockFeedInOnNegativePrices !== false && row.ec < 0
    ? FeedIn.blocked
    : FeedIn.allowed;
}

function isRebalanceSlot(index: number, options: DessMapperOptions): boolean {
  const window = options.rebalanceWindow;
  return window != null && index >= window.startIdx && index <= window.endIdx;
}

/**
 * Generic helper to find extreme prices (min/max) over a segment based on flow conditions.
 */
function aggregateSegmentPrice(
  rows: PlanRow[],
  segment: Segment | null,
  condition: (row: PlanRow) => boolean,
  getPrice: (row: PlanRow) => number,
  aggregator: 'max' | 'min'
): number {
  let bestPrice = aggregator === 'max' ? -Infinity : Infinity;
  if (!segment) return bestPrice;

  for (let t = segment.start; t <= segment.end; t++) {
    const row = rows[t];
    if (condition(row)) {
      const price = getPrice(row);
      bestPrice = aggregator === 'max' ? Math.max(bestPrice, price) : Math.min(bestPrice, price);
    }
  }
  return bestPrice;
}

/**
 * We want to find the tipping point price where battery usage is favored over grid usage.
 * Within the given segment, we look for grid flows that serve demand the battery could have
 * served instead — grid→load or grid→EV — and keep the highest price observed while the
 * battery still had discharge headroom. (Grid charging the EV at a high price while the
 * battery could have supplied it is the same revealed-marginal-value signal as grid→load.)
 */
function findHighestGridUsageCost(rows: PlanRow[], segment: Segment | null, cfg: SolverConfig): number {
  const maxDischarge = cfg.maxDischargePower_W - FLOW_EPSILON_W;
  return aggregateSegmentPrice(
    rows,
    segment,
    r => (r.g2l > FLOW_EPSILON_W || (r.g2ev ?? 0) > FLOW_EPSILON_W) && r.b2l + (r.b2ev ?? 0) < maxDischarge,
    r => r.ic,
    'max',
  );
}

/**
 * We want to find the tipping point price where grid charging is favored.
 * Within the given segment, we look for grid→battery flows and keep track of the highest price observed during these flows.
 */
function findHighestGridChargeCost(rows: PlanRow[], segment: Segment | null): number {
  return aggregateSegmentPrice(rows, segment, r => r.g2b > FLOW_EPSILON_W, r => r.ic, 'max');
}

/**
 * We want to find the tipping point price where battery exporting is favored.
 * Within the given segment, we look for battery→grid flows and keep track of the LOWEST export price (revenue) observed.
 * (i.e. we were willing to sell at this low price, so we'd definitely sell at higher prices).
 */
function findLowestGridExportRevenue(rows: PlanRow[], segment: Segment | null): number {
  return aggregateSegmentPrice(rows, segment, r => r.b2g > FLOW_EPSILON_W, r => r.ec, 'min');
}

/**
 * We want to find the tipping point price where PV export is favored.
 * Within the given segment, we look for pv→grid flows and keep track of the LOWEST export price.
 * (i.e. we were willing to export PV at this low price, so we'd definitely export at higher prices).
 */
function findLowestPvExportPrice(rows: PlanRow[], segment: Segment | null, cfg: SolverConfig): number {
  return aggregateSegmentPrice(
    rows,
    segment,
    r => {
      if (r.pv2g <= FLOW_EPSILON_W) return false;
      const chargePower = r.pv2b + r.g2b;
      const isChargeConstrained = chargePower >= cfg.maxChargePower_W - FLOW_EPSILON_W;
      const isSocConstrained = r.soc_percent >= cfg.maxSoc_percent - SOC_EPSILON_PERCENT;
      return !isChargeConstrained && !isSocConstrained;
    },
    r => r.ec,
    'min'
  );
}

/**
 * Checks if a rows's SoC is at (or very close to) either the min or max boundary.
 */
function isAtSocBoundary(row: PlanRow, cfg: SolverConfig): boolean {
  const soc = row.soc_percent;
  const atMin = soc <= cfg.minSoc_percent + SOC_EPSILON_PERCENT;
  const atMax = soc >= cfg.maxSoc_percent - SOC_EPSILON_PERCENT;
  return atMin || atMax;
}

function buildSegments(rows: PlanRow[], cfg: SolverConfig): Segment[] {
  const segments: Segment[] = [];
  let segmentStart = 0;

  for (let t = 0; t < rows.length; t++) {
    const row = rows[t];
    if (isAtSocBoundary(row, cfg)) {
      segments.push({ start: segmentStart, end: t });
      segmentStart = t + 1;
    }
  }
  segments.push({ start: segmentStart, end: rows.length - 1 });

  return segments;
}

function getSegmentForIndex(segments: Segment[], index: number): Segment | null {
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (index >= segment.start && index <= segment.end) {
      return segment;
    }
  }
  return null;
}

/**
 * Diagnostics helper for the UI:
 * - gridBatteryTippingPoint_cents_per_kWh: highest grid usage price
 *   in the first SoC segment (or null if none).
 * - gridChargeTippingPoint_cents_per_kWh: highest grid charge price
 *   in the first SoC segment (or null if none).
 * - batteryExportTippingPoint_cents_per_kWh: lowest battery export price
 *   in the first SoC segment (or null if none).
 * - pvExportTippingPoint_cents_per_kWh: lowest PV export price
 *   in the first SoC segment (or null if none).
 */
function computeDessDiagnostics(rows: PlanRow[], segments: Segment[], cfg: SolverConfig): DessDiagnostics {
  if (!rows.length) {
    return {
      gridBatteryTippingPoint_cents_per_kWh: -Infinity,
      gridChargeTippingPoint_cents_per_kWh: -Infinity,
      batteryExportTippingPoint_cents_per_kWh: Infinity,
      pvExportTippingPoint_cents_per_kWh: Infinity,
    };
  }
  const firstSegment = segments[0];
  const gridBatteryTp = findHighestGridUsageCost(rows, firstSegment, cfg);
  const gridChargeTp = findHighestGridChargeCost(rows, firstSegment);
  const batteryExportTp = findLowestGridExportRevenue(rows, firstSegment);
  const pvExportTp = findLowestPvExportPrice(rows, firstSegment, cfg);

  return {
    gridBatteryTippingPoint_cents_per_kWh: gridBatteryTp,
    gridChargeTippingPoint_cents_per_kWh: gridChargeTp,
    batteryExportTippingPoint_cents_per_kWh: batteryExportTp,
    pvExportTippingPoint_cents_per_kWh: pvExportTp,
  };
}

/**
 * V2 DESS mapper: simplified tipping-point-based strategy selection.
 *
 * Instead of analysing individual energy flows per slot, we compare
 * the slot's prices against per-segment tipping points:
 *   1. importCost <= gridChargeTp   → proBattery + allow grid→battery (charge)
 *   2. importCost <= gridBatteryTp  → proBattery + block both (use grid for load)
 *   3. exportPrice >= exportTp      → proGrid    + allow battery→grid (export)
 *   4. exportPrice >= pvExportTp    → proGrid    + block both (PV surplus to grid)
 *      (only when expected PV > expected load)
 *   5. else                         → selfConsumption + block both
 */
export function mapRowsToDessV2(rows: PlanRow[], cfg: SolverConfig, options: DessMapperOptions = {}): DessResult {
  const segments = buildSegments(rows, cfg);
  const perSlot = new Array<DessSlot>(rows.length);

  // Precompute tipping points once per segment (avoids O(T²) re-scanning)
  const segTps = new Map<Segment, SegmentTippingPoints>();
  for (const seg of segments) {
    segTps.set(seg, {
      gridChargeTp: findHighestGridChargeCost(rows, seg),
      gridBatteryTp: findHighestGridUsageCost(rows, seg, cfg),
      batteryExportTp: findLowestGridExportRevenue(rows, seg),
      pvExportTp: findLowestPvExportPrice(rows, seg, cfg),
    });
  }

  for (let t = 0; t < rows.length; t++) {
    const row = rows[t];

    const feedin = feedInForRow(row, options);

    const importCost = row.ic;
    const exportPrice = row.ec;
    let socTarget_percent = row.soc_percent;

    // Expected PV/load for PV surplus check
    const pvSurplus = row.pv > row.load + row.ev_charge + FLOW_EPSILON_W;

    // Precompute flow totals for saturation checks
    const gridImport = row.g2l + row.g2b + (row.g2ev ?? 0);
    const gridExport = row.b2g + row.pv2g;
    const chargePower = row.g2b + row.pv2b;
    const dischargePower = row.b2g + row.b2l + (row.b2ev ?? 0);

    // O(1) tipping-point lookup for this slot's segment
    const seg = getSegmentForIndex(segments, t);
    const { gridChargeTp, gridBatteryTp, batteryExportTp, pvExportTp } = segTps.get(seg!)!;

    let strategy: number;
    let restrictions: number;

    if (importCost <= gridChargeTp) {
      // Electricity is cheap enough to charge the battery from grid
      strategy = Strategy.proBattery;
      restrictions = Restrictions.batteryToGrid; // allow grid→battery
      if (gridImport >= cfg.maxGridImport_W - FLOW_EPSILON_W || chargePower >= cfg.maxChargePower_W - FLOW_EPSILON_W) {
        socTarget_percent = Math.min(socTarget_percent + 5, cfg.maxSoc_percent - 1);
      }
    } else if (importCost <= gridBatteryTp) {
      // Electricity is cheap enough to use grid for load (save battery)
      strategy = Strategy.proBattery;
      restrictions = Restrictions.both;
    } else if (exportPrice >= batteryExportTp) {
      // Export price is high enough to dump battery to grid
      strategy = Strategy.proGrid;
      restrictions = Restrictions.gridToBattery; // allow battery→grid
      if (gridExport >= cfg.maxGridExport_W - FLOW_EPSILON_W || dischargePower >= cfg.maxDischargePower_W - FLOW_EPSILON_W) {
        socTarget_percent = Math.max(socTarget_percent - 5, cfg.minSoc_percent + 1);
      }
    } else if (pvSurplus && exportPrice >= pvExportTp) {
      // PV surplus goes to grid (battery likely full)
      // Only applies when we actually expect PV to exceed load
      // Don't actively discharge battery — just allow PV export
      strategy = Strategy.proGrid;
      restrictions = Restrictions.both;
    } else {
      // Default: use battery for self-consumption
      strategy = Strategy.selfConsumption;
      restrictions = Restrictions.both;
    }

    const rebalancing = isRebalanceSlot(t, options);
    perSlot[t] = {
      feedin,
      // While rebalancing we must be able to top up from grid and must not drain to grid
      restrictions: rebalancing ? Restrictions.batteryToGrid : restrictions,
      strategy: rebalancing ? Strategy.proBattery : strategy,
      flags: 0,
      socTarget_percent: rebalancing ? 100 : socTarget_percent,
    };
  }

  const diagnostics = computeDessDiagnostics(rows, segments, cfg);

  return { perSlot, diagnostics };
}
