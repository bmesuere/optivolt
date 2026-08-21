import { lpVar } from './lp-vars.ts';

/**
 * Input for building a warm-start hint: the previous solve's solution columns
 * and the slot timing of both solves.
 */
export interface WarmStartInput {
  /** Columns of the previous solve's HiGHS solution. */
  columns: Record<string, { Primal?: number }>;
  /** Slot-0 timestamp of the previous solve. */
  prevStartMs: number;
  /** Slot-0 timestamp of the solve about to run. */
  nextStartMs: number;
  /** Slot length in minutes (must be the same for both solves). */
  stepMin: number;
}

/**
 * Build a warm-start hint for the next solve from the previous solve's
 * solution (issue #187).
 *
 * Only the binary decision skeleton is passed — the EV on/off pattern
 * (`ev_on_t`) and the rebalance window start (`start_balance_k`). Binaries
 * always have [0,1] bounds, so a shifted value can never be rejected as
 * out-of-bounds by HiGHS (which rejects the whole warm start on any
 * out-of-bounds entry); the continuous flows are reconstructed by HiGHS
 * itself, which fixes the supplied binaries and solves one LP to get an
 * incumbent (completeSolutionFromDiscreteAssignment).
 *
 * Slot indices are shifted by the whole number of slots elapsed between the
 * two solves. Slots that scrolled out of the horizon are dropped; hinted names
 * the new model doesn't contain are ignored by the solver wrapper; new-model
 * binaries without a hint are left for the solver to complete. An infeasible
 * hint (e.g. the shifted EV pattern no longer meets a target) is discarded by
 * HiGHS with a warning and the solve proceeds cold — never a wrong plan.
 *
 * Returns undefined when the horizons don't align (non-integer slot shift, or
 * the clock went backwards), where shifted indices would be meaningless.
 */
export function buildWarmStartColumns({ columns, prevStartMs, nextStartMs, stepMin }: WarmStartInput): Record<string, number> | undefined {
  const stepMs = stepMin * 60_000;
  if (!Number.isFinite(stepMs) || stepMs <= 0) return undefined;
  const deltaSlots = (nextStartMs - prevStartMs) / stepMs;
  if (!Number.isInteger(deltaSlots) || deltaSlots < 0) return undefined;

  const warm: Record<string, number> = {};
  for (const [name, col] of Object.entries(columns)) {
    const family = lpVar.evOn.parse(name) != null ? lpVar.evOn
      : lpVar.startBalance.parse(name) != null ? lpVar.startBalance
      : null;
    if (family == null) continue;
    const idx = family.parse(name)! - deltaSlots;
    if (idx < 0) continue;
    // Round away integrality slop; binaries are exactly 0 or 1 in a valid plan.
    warm[family.name(idx)] = Math.round(col.Primal ?? 0) === 1 ? 1 : 0;
  }
  return Object.keys(warm).length > 0 ? warm : undefined;
}
