import type { EvChargeMode } from '../../lib/types.ts';

/** The per-slot EV decision served by GET /ev/current. */
export interface EvCurrentDecision {
  ev_charge_W: number;
  ev_charge_A: number;
  ev_charge_mode: EvChargeMode;
  g2ev_W: number;
  pv2ev_W: number;
  b2ev_W: number;
}

// Matches the 1 W residual threshold parse-solution uses to classify EV flows.
const FLOW_THRESHOLD_W = 1;

/**
 * Live safety net for the home-battery floor: when the measured home battery SoC is below
 * `floor_percent`, the EV may only charge from PV. A planned decision that draws from the grid or
 * the battery is downgraded to `solar_only` (the charger tracks the actual PV surplus), keeping
 * only the planned PV share as the nominal rate. Decisions already PV-only or off pass through.
 *
 * With `gridAllowed` (the grid is currently cheaper than the energy in the battery plus wear) grid charging
 * is kept and only a planned battery share is dropped.
 *
 * Returns the (possibly adjusted) decision and whether the floor is currently active, so
 * automations can show why charging slowed down.
 */
export function applyEssFloorGuard(
  decision: EvCurrentDecision,
  essSoc_percent: number | null | undefined,
  floor_percent: number | null | undefined,
  gridAllowed = false,
): EvCurrentDecision & { ess_floor_active: boolean } {
  const floor = floor_percent ?? 0;
  const active = floor > 0 && essSoc_percent != null && Number.isFinite(essSoc_percent) && essSoc_percent < floor;
  if (!active) return { ...decision, ess_floor_active: false };

  const usesGridOrBattery = decision.g2ev_W > FLOW_THRESHOLD_W || decision.b2ev_W > FLOW_THRESHOLD_W;
  if (decision.ev_charge_mode === 'off' || !usesGridOrBattery) {
    return { ...decision, ess_floor_active: true };
  }
  if (gridAllowed && decision.g2ev_W > FLOW_THRESHOLD_W) {
    const charge_W = Math.max(0, decision.g2ev_W) + Math.max(0, decision.pv2ev_W);
    return {
      ...decision,
      ev_charge_W: charge_W,
      ev_charge_A: Math.round((charge_W / 230) * 1000) / 1000,
      b2ev_W: 0,
      ess_floor_active: true,
    };
  }
  const pv_W = Math.max(0, decision.pv2ev_W);
  return {
    ...decision,
    ev_charge_mode: 'solar_only' as EvChargeMode,
    ev_charge_W: pv_W,
    ev_charge_A: Math.round((pv_W / 230) * 1000) / 1000,
    g2ev_W: 0,
    b2ev_W: 0,
    ess_floor_active: true,
  };
}
