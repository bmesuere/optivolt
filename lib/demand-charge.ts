/**
 * demand-charge.ts
 *
 * Pure helpers for demand charges (peak tariffs): splitting the plan horizon
 * into billing periods, resolving each period's free threshold, reading a
 * "current peak" sensor value, and summarizing the planned outcome.
 *
 * Billing periods are calendar months in local time, which is how the Flemish
 * capaciteitstarief (and most monthly peak tariffs) bill. Like the load
 * predictors, "local" is the server's time zone.
 */

import type { DemandChargeConfig, DemandChargePeriod, DemandChargePeriodSummary, PlanRow } from './types.ts';

/** Start (ms) of the calendar month after the one containing `ms`, in local time. */
export function nextMonthStartMs(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
}

export interface DemandChargeInputs {
  /** Timestamp of slot 0. */
  startMs: number;
  stepMin: number;
  slotCount: number;
  /** Cost of raising a month's billed peak by 1 kW, in €/kW. */
  cost_eur_per_kW: number;
  /** Lowest peak the tariff ever bills (Flanders: 2500 W); import up to it is free in every month. */
  minPeak_W: number;
  /** Peak already reached in the current month (W), or undefined when unknown. */
  currentPeak_W?: number;
  /** Headroom kept below the threshold to absorb forecast error (W). */
  margin_W: number;
}

/**
 * Split the horizon into calendar-month periods and resolve each one's free
 * threshold. The current month starts from the peak already reached (when
 * known); every later month in the horizon starts from the minimum billed
 * peak, because peaks reset at the start of a billing period.
 *
 * Returns undefined when the charge is zero, so the LP stays unchanged.
 */
export function buildDemandChargeConfig({
  startMs,
  stepMin,
  slotCount,
  cost_eur_per_kW,
  minPeak_W,
  currentPeak_W,
  margin_W,
}: DemandChargeInputs): DemandChargeConfig | undefined {
  if (!(cost_eur_per_kW > 0) || !(slotCount > 0) || !(stepMin > 0)) return undefined;
  const stepMs = stepMin * 60_000;
  const floor_W = Math.max(0, minPeak_W);
  const known_W = currentPeak_W != null && Number.isFinite(currentPeak_W) ? Math.max(0, currentPeak_W) : 0;

  const periods: DemandChargePeriod[] = [];
  let startSlot = 0;
  while (startSlot < slotCount) {
    const boundaryMs = nextMonthStartMs(startMs + startSlot * stepMs);
    // First slot that starts at or after the next month boundary.
    const endSlot = Math.min(slotCount, Math.ceil((boundaryMs - startMs) / stepMs));
    const base_W = periods.length === 0 ? Math.max(floor_W, known_W) : floor_W;
    periods.push({ startSlot, endSlot, threshold_W: Math.max(0, base_W - Math.max(0, margin_W)) });
    startSlot = endSlot;
  }

  return { cost_cents_per_kW: cost_eur_per_kW * 100, periods };
}

/**
 * Convert a Home Assistant "peak this month" entity to watts. Accepts W and
 * kW (as reported by P1/DSMR, Fluvius, HomeWizard and similar integrations);
 * anything else — an unavailable state or an unknown unit — returns undefined
 * so the caller can fall back to the minimum billed peak.
 */
export function peakSensorToWatts(state: string, unit: unknown): number | undefined {
  const value = parseFloat(state);
  if (!Number.isFinite(value) || value < 0) return undefined;
  const u = typeof unit === 'string' ? unit.trim().toLowerCase() : '';
  if (u === 'w') return value;
  if (u === 'kw') return value * 1000;
  return undefined;
}

/** Planned peak and resulting demand-charge cost for each period. */
export function summarizeDemandCharge(rows: PlanRow[], cfg: DemandChargeConfig): DemandChargePeriodSummary[] {
  const out: DemandChargePeriodSummary[] = [];
  for (const p of cfg.periods) {
    const periodRows = rows.slice(p.startSlot, p.endSlot);
    if (periodRows.length === 0) continue;
    const plannedPeak_W = Math.max(0, ...periodRows.map((r) => r.imp));
    // Ignore sub-watt solver noise around a binding threshold.
    const rawExcess_W = plannedPeak_W - p.threshold_W;
    const excess_W = rawExcess_W >= 1 ? rawExcess_W : 0;
    out.push({
      startMs: periodRows[0].timestampMs,
      threshold_W: p.threshold_W,
      plannedPeak_W,
      excess_W,
      cost_cents: Math.round(excess_W / 1000 * cfg.cost_cents_per_kW * 100) / 100,
    });
  }
  return out;
}
