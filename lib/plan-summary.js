/**
 * Build high-level summary numbers for the plan:
 *  - totals for load / PV
 *  - load served from grid / battery / PV
 *  - import energy & energy-weighted avg import price
 *  - tipping point from DESS diagnostics
 */
export function buildPlanSummary(rows, cfg, dessDiagnostics = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      loadTotal_kWh: 0,
      pvTotal_kWh: 0,
      loadFromGrid_kWh: 0,
      loadFromBattery_kWh: 0,
      loadFromPv_kWh: 0,
      importEnergy_kWh: 0,
      avgImportPrice_cents_per_kWh: null,
      gridBatteryTippingPoint_cents_per_kWh:
        dessDiagnostics.gridBatteryTippingPoint_cents_per_kWh ?? null,
      gridChargeTippingPoint_cents_per_kWh:
        dessDiagnostics.gridChargeTippingPoint_cents_per_kWh ?? null,
      batteryExportTippingPoint_cents_per_kWh:
        dessDiagnostics.batteryExportTippingPoint_cents_per_kWh ?? null,
    };
  }

  const stepMinutes = Number(cfg.stepSize_m ?? 15);
  const stepHours =
    Number.isFinite(stepMinutes) && stepMinutes > 0 ? stepMinutes / 60 : 0.25;
  const W2kWh = (x) => (Number(x) || 0) * stepHours / 1000;

  let loadTotal = 0;
  let pvTotal = 0;
  let loadFromGrid = 0;
  let loadFromBattery = 0;
  let loadFromPv = 0;
  let gridToBattery = 0;
  let batteryToGrid = 0;
  let importEnergy = 0;
  let priceTimesEnergy = 0;

  for (const row of rows) {
    const loadK = W2kWh(row.load);
    const pvK = W2kWh(row.pv);
    const g2lK = W2kWh(row.g2l);
    const b2lK = W2kWh(row.b2l);
    const pv2lK = W2kWh(row.pv2l);
    const g2bK = W2kWh(row.g2b);
    const b2gK = W2kWh(row.b2g);
    const impK = W2kWh(row.imp);

    loadTotal += loadK;
    pvTotal += pvK;
    loadFromGrid += g2lK;
    loadFromBattery += b2lK;
    loadFromPv += pv2lK;
    gridToBattery += g2bK;
    batteryToGrid += b2gK;
    importEnergy += impK;

    const price = Number(row.ic);
    if (impK > 0 && Number.isFinite(price)) {
      priceTimesEnergy += price * impK;
    }
  }

  const avgImportPrice =
    importEnergy > 0 ? priceTimesEnergy / importEnergy : null;

  return {
    loadTotal_kWh: loadTotal,
    pvTotal_kWh: pvTotal,
    loadFromGrid_kWh: loadFromGrid,
    loadFromBattery_kWh: loadFromBattery,
    loadFromPv_kWh: loadFromPv,
    gridToBattery_kWh: gridToBattery,
    batteryToGrid_kWh: batteryToGrid,
    importEnergy_kWh: importEnergy,
    avgImportPrice_cents_per_kWh: avgImportPrice,
    gridBatteryTippingPoint_cents_per_kWh:
      Number.isFinite(dessDiagnostics.gridBatteryTippingPoint_cents_per_kWh)
        ? dessDiagnostics.gridBatteryTippingPoint_cents_per_kWh
        : null,
    gridChargeTippingPoint_cents_per_kWh:
      Number.isFinite(dessDiagnostics.gridChargeTippingPoint_cents_per_kWh)
        ? dessDiagnostics.gridChargeTippingPoint_cents_per_kWh
        : null,
    batteryExportTippingPoint_cents_per_kWh:
      Number.isFinite(dessDiagnostics.batteryExportTippingPoint_cents_per_kWh)
        ? dessDiagnostics.batteryExportTippingPoint_cents_per_kWh
        : null,
  };
}
