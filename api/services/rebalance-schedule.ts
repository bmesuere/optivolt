import type { Data, Settings } from '../types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The solver may start the hold this many days before the due date… */
export const REBALANCE_LEAD_DAYS = 3;
/** …and at the latest this many days after it. */
export const REBALANCE_GRACE_DAYS = 3;
/** Time the battery needs to get to the target first; the latest start is never closer than this. */
const MIN_LEAD_MS = DAY_MS;

export interface RebalanceSchedule {
  /** Rebalancing is planned this solve because the automatic schedule calls for it. */
  active: boolean;
  /** When the next automatic rebalance is due; null when the schedule is off. */
  dueMs: number | null;
  /** Latest moment the hold may start; null when not capped (schedule off or hold under way). */
  latestStartMs: number | null;
}

function parseMs(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The automatic rebalancing schedule (`rebalanceEveryWeeks`). A rebalance is due that many weeks
 * after the last completed one, or straight away when none was recorded yet. From
 * REBALANCE_LEAD_DAYS before the due date it is planned, and the solver picks the cheapest moment
 * in the horizon up to REBALANCE_GRACE_DAYS after it; past that the hold must start within a day.
 * A hold that has already started always runs to completion.
 */
export function getRebalanceSchedule(settings: Settings, data: Data, nowMs: number): RebalanceSchedule {
  const weeks = settings.rebalanceEveryWeeks ?? 0;
  if (!(weeks > 0)) return { active: false, dueMs: null, latestStartMs: null };
  const lastMs = parseMs(data.lastRebalanceAt);
  const dueMs = lastMs == null ? nowMs : lastMs + weeks * 7 * DAY_MS;
  if (data.rebalanceState?.startMs != null) return { active: true, dueMs, latestStartMs: null };
  const active = nowMs >= dueMs - REBALANCE_LEAD_DAYS * DAY_MS;
  const latestStartMs = Math.max(dueMs + REBALANCE_GRACE_DAYS * DAY_MS, nowMs + MIN_LEAD_MS);
  return { active, dueMs, latestStartMs: active ? latestStartMs : null };
}
