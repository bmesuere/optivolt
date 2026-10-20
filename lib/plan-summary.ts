/**
 * Build high-level summary numbers for the plan:
 *  - totals for load / PV
 *  - load served from grid / battery / PV
 *  - import energy & energy-weighted avg import price
 *  - tipping point from DESS diagnostics
 */

import type { PlanRow, SolverConfig, DessDiagnostics, PlanSummary, EvSessionSummary } from './types.ts';

type SummaryCfg = Pick<SolverConfig, 'stepSize_m'> & Partial<Pick<SolverConfig, 'ev' | 'dischargeEfficiency_percent'>>;

export function buildPlanSummary(
  rows: PlanRow[],
  cfg: SummaryCfg,
  dessDiagnostics: Partial<DessDiagnostics> = {},
  rebalance?: { enabled: boolean; startMs: number | null; remainingSlots: number },
  batteryEnergyPrice_cents_per_kWh: number | null = null,
): PlanSummary {
  const rebalanceStatus = rebalance?.enabled
    ? (rebalance.startMs != null ? 'active' : 'scheduled')
    : 'disabled';

  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      loadTotal_kWh: 0,
      pvTotal_kWh: 0,
      loadFromGrid_kWh: 0,
      loadFromBattery_kWh: 0,
      loadFromPv_kWh: 0,
      gridToBattery_kWh: 0,
      batteryToGrid_kWh: 0,
      importEnergy_kWh: 0,
      importCost_cents: 0,
      exportCost_cents: 0,
      netGridCost_cents: 0,
      avgImportPrice_cents_per_kWh: null,
      gridBatteryTippingPoint_cents_per_kWh:
        dessDiagnostics.gridBatteryTippingPoint_cents_per_kWh ?? null,
      gridChargeTippingPoint_cents_per_kWh:
        dessDiagnostics.gridChargeTippingPoint_cents_per_kWh ?? null,
      batteryExportTippingPoint_cents_per_kWh:
        dessDiagnostics.batteryExportTippingPoint_cents_per_kWh ?? null,
      pvExportTippingPoint_cents_per_kWh:
        dessDiagnostics.pvExportTippingPoint_cents_per_kWh ?? null,
      rebalanceStatus,
      evChargeTotal_kWh:       0,
      evChargeFromGrid_kWh:    0,
      evChargeFromPv_kWh:      0,
      evChargeFromBattery_kWh: 0,
      evChargeGridCost_cents:  0,
      evChargeEffectiveRate_cents_per_kWh: null,
      batteryEnergyPrice_cents_per_kWh,
      evSessions: [],
    };
  }

  const stepMinutes = cfg.stepSize_m;
  const stepHours =
    Number.isFinite(stepMinutes) && stepMinutes > 0 ? stepMinutes / 60 : 0.25;
  const W2kWh = (x: number) => x * stepHours / 1000;

  let loadTotal = 0;
  let pvTotal = 0;
  let loadFromGrid = 0;
  let loadFromBattery = 0;
  let loadFromPv = 0;
  let gridToBattery = 0;
  let batteryToGrid = 0;
  let importEnergy = 0;
  let priceTimesEnergy = 0;
  let importCost = 0;
  let exportCost = 0;
  let evFromGrid = 0;
  let evFromPv   = 0;
  let evFromBat  = 0;
  let evGridCost = 0;

  for (const row of rows) {
    const loadK = W2kWh(row.load);
    const pvK = W2kWh(row.pv);
    const g2lK = W2kWh(row.g2l);
    const b2lK = W2kWh(row.b2l);
    const pv2lK = W2kWh(row.pv2l);
    const g2bK = W2kWh(row.g2b);
    const b2gK = W2kWh(row.b2g);
    const impK = W2kWh(row.imp);
    const expK = W2kWh(row.exp);

    loadTotal += loadK;
    pvTotal += pvK;
    loadFromGrid += g2lK;
    loadFromBattery += b2lK;
    loadFromPv += pv2lK;
    gridToBattery += g2bK;
    batteryToGrid += b2gK;
    importEnergy += impK;

    if (impK > 0) {
      priceTimesEnergy += row.ic * impK;
    }
    importCost += finiteOr(row.importCost_cents, impK * row.ic);
    exportCost += finiteOr(row.exportCost_cents, expK * row.ec);
    const g2evK = W2kWh(row.g2ev ?? 0);
    evFromGrid += g2evK;
    evFromPv   += W2kWh(row.pv2ev ?? 0);
    evFromBat  += W2kWh(row.b2ev ?? 0);
    evGridCost += g2evK * row.ic;
  }

  const avgImportPrice =
    importEnergy > 0 ? priceTimesEnergy / importEnergy : null;
  const evTotal = evFromGrid + evFromPv + evFromBat;

  return {
    loadTotal_kWh: loadTotal,
    pvTotal_kWh: pvTotal,
    loadFromGrid_kWh: loadFromGrid,
    loadFromBattery_kWh: loadFromBattery,
    loadFromPv_kWh: loadFromPv,
    gridToBattery_kWh: gridToBattery,
    batteryToGrid_kWh: batteryToGrid,
    importEnergy_kWh: importEnergy,
    importCost_cents: importCost,
    exportCost_cents: exportCost,
    netGridCost_cents: importCost - exportCost,
    avgImportPrice_cents_per_kWh: avgImportPrice,
    gridBatteryTippingPoint_cents_per_kWh:
      Number.isFinite(dessDiagnostics.gridBatteryTippingPoint_cents_per_kWh)
        ? dessDiagnostics.gridBatteryTippingPoint_cents_per_kWh!
        : null,
    gridChargeTippingPoint_cents_per_kWh:
      Number.isFinite(dessDiagnostics.gridChargeTippingPoint_cents_per_kWh)
        ? dessDiagnostics.gridChargeTippingPoint_cents_per_kWh!
        : null,
    batteryExportTippingPoint_cents_per_kWh:
      Number.isFinite(dessDiagnostics.batteryExportTippingPoint_cents_per_kWh)
        ? dessDiagnostics.batteryExportTippingPoint_cents_per_kWh!
        : null,
    pvExportTippingPoint_cents_per_kWh:
      Number.isFinite(dessDiagnostics.pvExportTippingPoint_cents_per_kWh)
        ? dessDiagnostics.pvExportTippingPoint_cents_per_kWh!
        : null,
    rebalanceStatus,
    evChargeTotal_kWh:       evTotal,
    evChargeFromGrid_kWh:    evFromGrid,
    evChargeFromPv_kWh:      evFromPv,
    evChargeFromBattery_kWh: evFromBat,
    evChargeGridCost_cents:  evGridCost,
    // Grid cost per kWh of *all* EV energy — PV and battery kWh dilute the rate.
    evChargeEffectiveRate_cents_per_kWh: evTotal > 0 ? evGridCost / evTotal : null,
    batteryEnergyPrice_cents_per_kWh,
    evSessions: buildEvSessions(rows, cfg, stepHours, batteryEnergyPrice_cents_per_kWh),
  };
}

/**
 * Split the planned EV charging into sessions and cost each one. A session is a stretch of
 * consecutive slots in which the EV may charge (inside an availability window), so a night
 * with a pause during expensive hours is still one session. Without an EV config a session is
 * a run of consecutive charging slots.
 *
 * Battery energy is costed at the battery energy price going into the slot, divided by the
 * discharge efficiency (the battery gives up more than the EV receives).
 */
function buildEvSessions(
  rows: PlanRow[],
  cfg: SummaryCfg,
  stepHours: number,
  initialBatteryPrice: number | null,
): EvSessionSummary[] {
  const T = rows.length;
  const ev = cfg.ev;
  let mayCharge: boolean[];
  if (ev) {
    mayCharge = Array(T).fill(false);
    for (const w of ev.availabilityWindows) {
      for (let t = Math.max(0, w.startSlot); t < Math.min(T, w.endSlot); t++) mayCharge[t] = true;
    }
  } else {
    mayCharge = rows.map((r) => (r.ev_charge ?? 0) > 0);
  }
  const dischargeEfficiency = (cfg.dischargeEfficiency_percent ?? 100) / 100;
  const stepMs = stepHours * 3_600_000;
  const W2kWh = (x: number) => x * stepHours / 1000;

  const sessions: EvSessionSummary[] = [];
  let current: EvSessionSummary | null = null;
  const close = () => {
    if (current && current.energy_kWh > 0) {
      current.cost_cents = current.gridCost_cents + current.batteryCost_cents;
      current.rate_cents_per_kWh = current.cost_cents / current.energy_kWh;
      sessions.push(current);
    }
    current = null;
  };
  for (let t = 0; t < T; t++) {
    const row = rows[t];
    const charging = (row.ev_charge ?? 0) > 0;
    if (charging) {
      current ??= {
        startMs: row.timestampMs, endMs: row.timestampMs, energy_kWh: 0, fromGrid_kWh: 0, fromPv_kWh: 0,
        fromBattery_kWh: 0, gridCost_cents: 0, batteryCost_cents: 0, cost_cents: 0, rate_cents_per_kWh: 0,
      };
      const grid = W2kWh(row.g2ev ?? 0);
      const pv = W2kWh(row.pv2ev ?? 0);
      const battery = W2kWh(row.b2ev ?? 0);
      const batteryPrice = (t > 0 ? rows[t - 1].batteryEnergyPrice_cents_per_kWh : initialBatteryPrice) ?? 0;
      current.endMs = row.timestampMs + stepMs;
      current.energy_kWh += grid + pv + battery;
      current.fromGrid_kWh += grid;
      current.fromPv_kWh += pv;
      current.fromBattery_kWh += battery;
      current.gridCost_cents += grid * row.ic;
      current.batteryCost_cents += dischargeEfficiency > 0 ? (battery * batteryPrice) / dischargeEfficiency : 0;
    }
    // The stretch ends at a slot that may not charge; a new availability window is a new
    // session even when it follows the previous one directly.
    if (!mayCharge[t] && !charging) close();
    else if (ev && isWindowStart(ev.availabilityWindows, t + 1)) close();
  }
  close();
  return sessions;
}

function isWindowStart(windows: { startSlot: number }[], slot: number): boolean {
  return windows.some((w) => w.startSlot === slot);
}

function finiteOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
