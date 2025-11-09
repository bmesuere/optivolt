// Mapper that attaches DESS decisions per slot.
// Assumes a complete, valid cfg is provided.

const FLOW_EPSILON_W = 1; // treat flows below this as zero

export const Strategy = {
  targetSoc: 0,       // excess PV and load to/from grid
  selfConsumption: 1, // excess PV and load to/from battery
  proBattery: 2,      // excess PV to battery, excess load from grid
  proGrid: 3,         // excess PV to grid, excess load from battery
  unknown: -1,
};

export const Restrictions = {
  none: 0,            // no restrictions between battery and grid
  gridToBattery: 1,   // restrict grid → battery
  batteryToGrid: 2,   // restrict battery → grid
  both: 3,            // block both directions
  unknown: -1,
};

export const FeedIn = {
  allowed: 1,
  blocked: 0,
};

export function mapRowsToDess(rows, cfg) {
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

    // SoC refs
    const startOfSlotSoc_Wh = t > 0 ? Number(rows[t - 1].soc) : Number(row.soc);
    let socTarget_Wh = Number(row.soc);

    // Strategy selection (nested; only observed cases are assigned)
    let strategy = Strategy.unknown;

    if (hasG2B) {
      // There's a grid charging flow which probably means electricity is cheap.
      // This means we'll want to use the grid as much as possible and store PV in the battery.
      // So we set pro-battery (and a target SoC that's higher than current SoC)
      strategy = Strategy.proBattery;
    } else if (hasB2G) {
      // There's an active discharge to grid which probably means electricity is expensive.
      // This means we'll want to use the battery for our own load as much as possible and export excess PV to the grid.
      // I haven't observed this case yet, but it's presumably pro-grid (and a target SoC lower than current SoC)
      // TODO: strategy remains unknown
    } else {
      if (deficitOrNoPv) {
        // We have a deficit to cover our planned loads.
        // Based on how this deficit is covered according to the plan, we can use the same handling for unexpected loads.
        // TODO: technically, if we have an unexpected PV surplus, we might also want to inject that into the grid. We don't handle that yet. If we do, we must also adapt the restrictions.
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
          // TODO: simulate to determine if pro-battery or self-consumption is better? Or use a price indicator?
          strategy = Strategy.selfConsumption;
        } else {
          // PV deficit is served by both battery and grid.
          // We have thus no clear indication of how to handle unexpected loads.
          // I haven't observed this case yet, but I think it makes sense to use the grid here because the mix probably indicates that the battery is low.
          // TODO: strategy remains unknown
        }
      } else if (pvCoversLoad) {
        // In this case, PV is expected to cover all load and we have excess PV.
        // Based on how this excess PV is used according to the plan, we can use the same handling for unexpected excess PV.
        // It is however less clear how unexpected loads should be covered in this case.
        if (hasPV2B) {
          // If we see PV2B -> use self-consumption to cover the unexpected loads by battery or pro battery to cover by grid.
          // TODO: simulate to determine if pro-battery or self-consumption is better? Or use a price indicator?
          strategy = Strategy.selfConsumption;
        } else {
          // In this case, we see PV2G, but I haven't observed this yet.
          // TODO: strategy remains unknown
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
      socTarget_Wh,
    };
  }

  return { perSlot };
}
