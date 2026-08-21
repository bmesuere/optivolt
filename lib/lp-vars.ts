/**
 * Single home for the LP variable-name contract.
 *
 * build-lp.ts writes variable names, parse-solution.ts and the planner read
 * them back out of the HiGHS solution; both sides must agree exactly. Each
 * family pairs `name(t)` with a `parse(varName)` that matches only
 * `<prefix>_<digits>` exactly, so overlapping prefixes (soc_3 vs
 * soc_shortfall_3) can never collide.
 */

interface LpVarFamily {
  prefix: string;
  name(t: number): string;
  /** Slot/window index if varName belongs to this family, else null. */
  parse(varName: string): number | null;
}

function makeFamily(prefix: string): LpVarFamily {
  const re = new RegExp(`^${prefix}_(\\d+)$`);
  return {
    prefix,
    name: (t) => `${prefix}_${t}`,
    parse: (varName) => {
      const m = re.exec(varName);
      return m ? Number(m[1]) : null;
    },
  };
}

export const lpVar = {
  gridToLoad:    makeFamily('grid_to_load'),
  gridToBattery: makeFamily('grid_to_battery'),
  pvToLoad:      makeFamily('pv_to_load'),
  pvToBattery:   makeFamily('pv_to_battery'),
  pvToGrid:      makeFamily('pv_to_grid'),
  batteryToLoad: makeFamily('battery_to_load'),
  batteryToGrid: makeFamily('battery_to_grid'),
  soc:           makeFamily('soc'),
  socShortfall:  makeFamily('soc_shortfall'),
  gridToEv:      makeFamily('grid_to_ev'),
  pvToEv:        makeFamily('pv_to_ev'),
  batteryToEv:   makeFamily('battery_to_ev'),
  evOn:          makeFamily('ev_on'),
  evSoc:         makeFamily('ev_soc'),
  startBalance:  makeFamily('start_balance'),
  balanceOn:     makeFamily('balance_on'),
} as const;

export interface RebalanceWindow {
  startIdx: number;
  endIdx: number;
}

/**
 * Find which contiguous slot range the MILP solver selected for rebalancing.
 * Scans solution columns for the `start_balance_k` start indicator that equals
 * 1 (continuous, but forced to exactly 1 at the chosen start by the step
 * constraints in build-lp.ts).
 */
export function extractRebalanceWindow(
  columns: Record<string, { Primal?: number }>,
  remainingSlots: number,
): RebalanceWindow | undefined {
  if (remainingSlots <= 0) return undefined;
  for (const [name, col] of Object.entries(columns)) {
    const k = lpVar.startBalance.parse(name);
    if (k != null && Math.round(col.Primal ?? 0) === 1) {
      return { startIdx: k, endIdx: k + remainingSlots - 1 };
    }
  }
  return undefined;
}
