// Mapper that attaches DESS decisions per slot.
// Assumes a complete, valid cfg is provided.

const FLOW_EPSILON_W = 1; // treat flows below this as zero
const SOC_EPSILON_PERCENT = 0.5; // treat SoC within this of min/max as at boundary

export const Strategy = {
  targetSoc: 0,       // excess PV and load to/from grid
  selfConsumption: 1, // excess PV and load to/from battery
  proBattery: 2,      // excess PV to battery, excess load from grid
  proGrid: 3,         // excess PV to grid, excess load from battery
  unknown: -1,
};

export const Restrictions = {
  none: 0,            // no restrictions between battery and grid
  batteryToGrid: 1,   // restrict battery → grid
  gridToBattery: 2,   // restrict grid → battery
  both: 3,            // block both directions
  unknown: -1,
};

export const FeedIn = {
  allowed: 1,
  blocked: 0,
};

export function mapRowsToDess(rows, cfg) {
  const segments = buildSegments(rows, cfg);
  const perSlot = new Array(rows.length);

  for (let t = 0; t < rows.length; t++) {
    const row = rows[t];

    // Feed-in: allow unless export price is negative.
    const feedin = Number(row.ec) < 0 ? FeedIn.blocked : FeedIn.allowed;

    // Primitive flows (absolute)
    const g2l = Math.abs(Number(row.g2l) || 0);
    const g2b = Math.abs(Number(row.g2b) || 0);
    const pv2l = Math.abs(Number(row.pv2l) || 0);
    const pv2b = Math.abs(Number(row.pv2b) || 0);
    const pv2g = Math.abs(Number(row.pv2g) || 0);
    const b2l = Math.abs(Number(row.b2l) || 0);
    const b2g = Math.abs(Number(row.b2g) || 0);

    // Flow booleans
    const hasG2L = g2l > FLOW_EPSILON_W;
    const hasG2B = g2b > FLOW_EPSILON_W;
    const hasB2L = b2l > FLOW_EPSILON_W;
    const hasB2G = b2g > FLOW_EPSILON_W;
    const hasPV2B = pv2b > FLOW_EPSILON_W;

    // PV presence (realized flows)
    const pvFlow = pv2l + pv2b + pv2g;
    const hasNoPvFlow = pvFlow <= FLOW_EPSILON_W;

    // Expectations (from inputs)
    const expectedPv = Number(row.pv) || 0;
    const expectedLoad = Number(row.load) || 0;
    const pvCoversLoad = expectedPv >= (expectedLoad - FLOW_EPSILON_W);
    const loadExceedsPv = expectedLoad > (expectedPv + FLOW_EPSILON_W);

    // Combine branches: “no PV flow” behaves like “expected deficit”
    const deficitOrNoPv = hasNoPvFlow || loadExceedsPv;

    // costs and prices
    const importCost = Number(row.ic);
    // const exportPrice = Number(row.ec);

    // SoC refs
    const _startOfSlotSoc_Wh = t > 0 ? Number(rows[t - 1].soc) : Number(row.soc);
    let socTarget_percent = row.soc_percent;

    // Strategy selection
    let strategy = Strategy.unknown;

    if (hasG2B) {
      // There's a grid charging flow which probably means electricity is cheap.
      // This means we'll want to use the grid as much as possible and store PV in the battery.
      // So we set pro-battery (and a target SoC that's higher than current SoC)
      strategy = Strategy.proBattery;
      if (g2l + g2b >= cfg.maxGridImport_W - FLOW_EPSILON_W) {
        // Grid import is at (or very close to) max capacity.
        // We want to make sure to charge at max speed, even if the load would be lower than expected.
        // So we artificially increase the target SoC.
        socTarget_percent = Math.min(socTarget_percent + 5, cfg.maxSoc_percent - 1);
      }
    } else if (hasB2G) {
      // There's an active discharge to grid which probably means electricity is expensive.
      // This means we'll want to use the battery for our own load as much as possible and export excess PV to the grid.
      // I haven't observed this case yet, but it's presumably pro-grid (and a target SoC lower than current SoC)
      // TODO: validate
      strategy = Strategy.proGrid;
    } else {
      if (deficitOrNoPv) {
        // We have a deficit to cover our planned loads.
        // Based on how this deficit is covered according to the plan, we can use the same handling for unexpected loads.
        // TODO: technically, if we have an unexpected PV surplus, we might also want to inject that into the grid. We don't handle that yet.
        // We can look if we have x2g flows (not due to inverter power cap) on the same day and determine the lowest price of any of these periods. If the current price is higher than that, we can assume excess PV should go to grid.
        if (hasB2L && !hasG2L) {
          // The battery is used to cover the deficit, so we'll do the same for unexpected loads.
          strategy = Strategy.selfConsumption;
        } else if (hasG2L && !hasB2L) {
          // The grid is used to cover the deficit, so we'll do the same for unexpected loads.
          // Target SoC should be close to current SoC or the reactive strategy will ignore the grid restrictions
          strategy = Strategy.proBattery;
        } else if (!hasB2L && !hasG2L) {
          // Predicted PV is exactly equal to predicted load, so there's no deficit handling in the plan.
          // We have thus no indication of how to handle unexpected loads.
          // We try to infer this from price signals.
          if (importCost <= findHighestGridUsageCost(rows, getSegmentForIndex(segments, t), cfg)) {
            strategy = Strategy.proBattery;
          } else {
            strategy = Strategy.selfConsumption;
          }
        } else {
          // PV deficit is served by both battery and grid.
          // We have thus no clear indication of how to handle unexpected loads.
          // A potential reason is that predicted load is higher than grid capacity which is why battery is also used.
          // Another reason might be that this quarter is a price tipping point where the last of the available battery is planned in.
          strategy = Strategy.proBattery;
        }
      } else if (pvCoversLoad) {
        // In this case, PV is expected to cover all load and we have additional PV.
        // Based on how this additional PV is used according to the plan, we can use the same handling for excess PV.
        // It is however less clear how unexpected loads should be covered in this case.
        if (hasPV2B) {
          // If we see PV2B -> use self-consumption to cover the unexpected loads by battery or pro battery to cover by grid.
          // We also use the price signals to decide.
          if (importCost <= findHighestGridUsageCost(rows, getSegmentForIndex(segments, t), cfg)) {
            strategy = Strategy.proBattery;
          } else {
            strategy = Strategy.selfConsumption;
          }
        } else {
          // In this case, we see PV2G, but I haven't observed this yet.
          // Excess PV should go to grid, so we have targetSoC or pro-grid.
          // Since we're already exporting to grid, pro-grid makes more sense. Or should we also use a price indicator here?
          // TODO: validate
          strategy = Strategy.proGrid;
        }
      } else {
        // I don't think we can reach this branch?
      }
    }

    // Restrictions: start with both blocked; allow only directions actually used
    let restrictions = Restrictions.both;
    if (hasG2B && hasB2G) {
      restrictions = Restrictions.none;
    } else if (hasG2B && !hasB2G) {
      restrictions = Restrictions.batteryToGrid;   // allow grid→battery
    } else if (!hasG2B && hasB2G) {
      restrictions = Restrictions.gridToBattery;   // allow battery→grid
    } else {
      restrictions = Restrictions.both;
    }

    perSlot[t] = {
      feedin,               // FeedIn.allowed | FeedIn.blocked
      restrictions,         // Restrictions.*
      strategy,             // Strategy.* or unknown
      flags: 0,
      socTarget_percent,
    };
  }

  const diagnostics = computeDessDiagnostics(rows, segments, cfg);

  return { perSlot, diagnostics };
}

/**
 * We want to find the tipping point price where battery usage is favored over grid usage.
 * Within the given segment, we look for grid→load flows and keep track of the highest price observed during these flows.
 */
function findHighestGridUsageCost(rows, segment, cfg) {
  let highestPrice = -Infinity;
  if (!segment) return highestPrice;

  const maxDischarge = Number(cfg.maxDischargePower_W) - FLOW_EPSILON_W;

  for (let t = segment.start; t <= segment.end; t++) {
    const row = rows[t];
    const g2l = Math.abs(Number(row.g2l) || 0);
    const b2l = Math.abs(Number(row.b2l) || 0);

    if (g2l > FLOW_EPSILON_W && b2l < maxDischarge) {
      const price = Number(row.ic) || 0;
      if (price > highestPrice) {
        highestPrice = price;
      }
    }
  }
  return highestPrice;
}

/**
 * We want to find the tipping point price where grid charging is favored.
 * Within the given segment, we look for grid→battery flows and keep track of the highest price observed during these flows.
 */
function findHighestGridChargeCost(rows, segment, cfg) {
  let highestPrice = -Infinity;
  if (!segment) return highestPrice;

  // If we charge, we charge. We don't necessarily need to check maxCharge, just that flow > epsilon.

  for (let t = segment.start; t <= segment.end; t++) {
    const row = rows[t];
    const g2b = Math.abs(Number(row.g2b) || 0);

    if (g2b > FLOW_EPSILON_W) {
      const price = Number(row.ic) || 0;
      if (price > highestPrice) {
        highestPrice = price;
      }
    }
  }
  return highestPrice;
}

/**
 * We want to find the tipping point price where battery exporting is favored.
 * Within the given segment, we look for battery→grid flows and keep track of the LOWEST export price (revenue) observed.
 * (i.e. we were willing to sell at this low price, so we'd definitely sell at higher prices).
 */
function findLowestGridExportRevenue(rows, segment, cfg) {
  let lowestPrice = Infinity;
  if (!segment) return lowestPrice;

  for (let t = segment.start; t <= segment.end; t++) {
    const row = rows[t];
    const b2g = Math.abs(Number(row.b2g) || 0);

    if (b2g > FLOW_EPSILON_W) {
      const price = Number(row.ec) || 0;
      if (price < lowestPrice) {
        lowestPrice = price;
      }
    }
  }
  return lowestPrice;
}

/**
 * Checks if a rows's SoC is at (or very close to) either the min or max boundary.
 */
function isAtSocBoundary(row, cfg) {
  const soc = Number(row.soc_percent);
  const atMin = soc <= cfg.minSoc_percent + SOC_EPSILON_PERCENT;
  const atMax = soc >= cfg.maxSoc_percent - SOC_EPSILON_PERCENT;
  return atMin || atMax;
}

function buildSegments(rows, cfg) {
  const segments = [];
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

function getSegmentForIndex(segments, index) {
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
 */
function computeDessDiagnostics(rows, segments, cfg) {
  if (!Array.isArray(rows) || !rows.length) {
    return {
      gridBatteryTippingPoint_cents_per_kWh: -Infinity,
      gridChargeTippingPoint_cents_per_kWh: -Infinity,
      batteryExportTippingPoint_cents_per_kWh: Infinity,
    };
  }
  const firstSegment = segments[0];
  const gridBatteryTp = findHighestGridUsageCost(rows, firstSegment, cfg);
  const gridChargeTp = findHighestGridChargeCost(rows, firstSegment, cfg);
  const batteryExportTp = findLowestGridExportRevenue(rows, firstSegment, cfg);

  return {
    gridBatteryTippingPoint_cents_per_kWh: gridBatteryTp,
    gridChargeTippingPoint_cents_per_kWh: gridChargeTp,
    batteryExportTippingPoint_cents_per_kWh: batteryExportTp,
  };
}
