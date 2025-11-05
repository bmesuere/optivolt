// src/dess-mapper.js
//
// Dry-run mapper that attaches DESS decisions per slot.
// Assumes a complete, valid cfg is provided.

const FLOW_EPSILON_W = 1; // treat flows below this as zero

export const Strategy = {
  targetSoc: 0,
  selfConsumption: 1,
  proBattery: 2,
  proGrid: 3,
  unknown: -1,
};

export const Restrictions = {
  none: 0,
  gridToBattery: 1,
  batteryToGrid: 2,
  both: 3,
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

    // Group signals
    const pvFlow = pv2l + pv2b + pv2g;

    // Booleans for readability
    const hasPvFlow = pvFlow > FLOW_EPSILON_W;
    const hasNoPvFlow = !hasPvFlow;

    const hasB2L = b2l > FLOW_EPSILON_W;
    const hasB2G = b2g > FLOW_EPSILON_W;
    const hasG2L = g2l > FLOW_EPSILON_W;
    const hasG2B = g2b > FLOW_EPSILON_W;
    const hasAnyDischarge = hasB2L || hasB2G;

    const onlyBatteryToLoad = hasNoPvFlow && hasB2L && !hasG2L && !hasG2B && !hasB2G;
    const onlyGridToLoad = hasNoPvFlow && hasG2L && !hasG2B && !hasB2L && !hasB2G;

    // Expectations (not realized flows)
    const expectedPv = Number(row.pv) || 0;
    const expectedLoad = Number(row.load) || 0;
    const pvCoversLoad = expectedPv >= (expectedLoad - FLOW_EPSILON_W);
    const loadExceedsPv = expectedLoad > (expectedPv + FLOW_EPSILON_W);

    // SoC targets
    const startOfSlotSoc_Wh = t > 0 ? Number(rows[t - 1].soc) : Number(row.soc);
    let socTarget_Wh = Number(row.soc);

    // Strategy (codes in Strategy)
    let strategy = Strategy.unknown;

    // 1) No PV, only Battery→Load → Self-consumption
    if (onlyBatteryToLoad) {
      strategy = Strategy.selfConsumption;
    }
    // 2) No PV, only Grid→Load → Pro battery (hold SoC flat)
    else if (onlyGridToLoad) {
      strategy = Strategy.proBattery;
      socTarget_Wh = startOfSlotSoc_Wh;
    }
    // 3) Charging battery from grid (no simultaneous discharge) → Pro battery
    else if (hasG2B && !hasAnyDischarge) {
      strategy = Strategy.proBattery;
    }
    // 4) Expected deficit (load > PV) and the plan uses the battery → Self-consumption
    //    This encodes: in deficit slots, if the LP draws from the battery, let battery cover deviations.
    else if (strategy === Strategy.unknown && loadExceedsPv && hasB2L) {
      strategy = Strategy.selfConsumption;
    }
    // 5) Expected PV covers expected load → Self-consumption
    //    Note: might not always be optimal if actual load exceeds forecast; future rule could prefer grid for deviations.
    else if (strategy === Strategy.unknown && pvCoversLoad) {
      strategy = Strategy.selfConsumption;
    }

    perSlot[t] = {
      feedin,                           // FeedIn.allowed | FeedIn.blocked
      restrictions: Restrictions.unknown,
      strategy,                         // Strategy.* or Strategy.unknown
      flags: 0,
      socTarget_Wh,
    };
  }

  return { perSlot };
}
