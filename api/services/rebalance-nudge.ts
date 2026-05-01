import type { Data, SocData } from '../types.ts';

export const FULL_SOC_PERCENT = 100;
export const REBALANCE_NUDGE_AFTER_DAYS = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RebalanceNudge {
  lastFullSocAt: string | null;
  daysSinceLastFullSoc: number | null;
  rebalanceRecommended: boolean;
  thresholdDays: number;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function recordFullSocObservation(data: Data, soc: SocData = data.soc): Data {
  if (!Number.isFinite(soc.value) || soc.value < FULL_SOC_PERCENT) return data;

  const observedMs = parseTimestampMs(soc.timestamp);
  if (observedMs == null) return data;

  const existingMs = parseTimestampMs(data.lastFullSocAt);
  if (existingMs != null && existingMs >= observedMs) return data;

  return {
    ...data,
    lastFullSocAt: new Date(observedMs).toISOString(),
  };
}

export function getRebalanceNudge(data: Data, nowMs = Date.now()): RebalanceNudge {
  const lastFullMs = parseTimestampMs(data.lastFullSocAt);
  if (lastFullMs == null) {
    return {
      lastFullSocAt: null,
      daysSinceLastFullSoc: null,
      rebalanceRecommended: false,
      thresholdDays: REBALANCE_NUDGE_AFTER_DAYS,
    };
  }

  const elapsedMs = Math.max(0, nowMs - lastFullMs);
  return {
    lastFullSocAt: new Date(lastFullMs).toISOString(),
    daysSinceLastFullSoc: Math.floor(elapsedMs / DAY_MS),
    rebalanceRecommended: elapsedMs > REBALANCE_NUDGE_AFTER_DAYS * DAY_MS,
    thresholdDays: REBALANCE_NUDGE_AFTER_DAYS,
  };
}
