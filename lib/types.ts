/**
 * Shared type definitions for the OptiVolt solver pipeline.
 */

export type TerminalSocValuation = 'zero' | 'min' | 'avg' | 'max' | 'custom';

/**
 * Fully resolved solver configuration, as produced by config-builder.
 * All scalar fields are validated and present; arrays are aligned time series.
 */
export interface SolverConfig {
  // Time series
  load_W: number[];
  pv_W: number[];
  importPrice: number[];
  exportPrice: number[];

  // Battery parameters
  stepSize_m: number;
  batteryCapacity_Wh: number;
  minSoc_percent: number;
  maxSoc_percent: number;
  maxChargePower_W: number;
  maxDischargePower_W: number;
  maxGridImport_W: number;
  maxGridExport_W: number;
  chargeEfficiency_percent: number;
  dischargeEfficiency_percent: number;
  batteryCost_cent_per_kWh: number;
  idleDrain_W: number;

  // Terminal SoC valuation
  terminalSocValuation: TerminalSocValuation;
  terminalSocCustomPrice_cents_per_kWh: number;

  // Initial state
  initialSoc_percent: number;

  // Algorithm selection
  dessAlgorithm: 'v1' | 'v2';

  // Rebalancing (optional — only present when rebalanceEnabled is true)
  rebalanceHoldSlots?: number;
  rebalanceRemainingSlots?: number;
  rebalanceTargetSoc_percent?: number;
}

/**
 * A time-series source object as stored in data.json.
 */
export interface TimeSeries {
  start: string;
  step?: number;
  values: number[];
}

/**
 * A single per-slot row produced by parseSolution.
 * All flow values are in W (rounded to 3 decimal places); soc is in Wh.
 */
export interface PlanRow {
  tIdx: number;
  timestampMs: number;
  load: number;       // expected load W
  pv: number;         // expected PV W
  ic: number;  // import price c€/kWh
  ec: number;  // export price c€/kWh
  g2l: number;   // grid → load W
  g2b: number;   // grid → battery W
  pv2l: number;  // PV → load W
  pv2b: number;  // PV → battery W
  pv2g: number;  // PV → grid W
  b2l: number;   // battery → load W
  b2g: number;   // battery → grid W
  imp: number;   // total import W (g2l + g2b)
  exp: number;   // total export W (pv2g + b2g)
  soc: number;   // battery SoC Wh
  soc_percent: number;  // battery SoC %
}

/**
 * Tipping-point diagnostics produced by the DESS mapper.
 * Infinity / -Infinity indicate "no flow observed" in the relevant direction.
 */
export interface DessDiagnostics {
  gridBatteryTippingPoint_cents_per_kWh: number;
  gridChargeTippingPoint_cents_per_kWh: number;
  batteryExportTippingPoint_cents_per_kWh: number;
  pvExportTippingPoint_cents_per_kWh: number;
}

/**
 * A single DESS schedule slot as sent to Victron Dynamic ESS.
 */
export interface DessSlot {
  feedin: number;
  restrictions: number;
  strategy: number;
  flags: number;
  socTarget_percent: number;
}

/**
 * Full output of the DESS mapper.
 */
export interface DessResult {
  perSlot: DessSlot[];
  diagnostics: DessDiagnostics;
}

/**
 * High-level plan summary computed from solved rows.
 */
export interface PlanSummary {
  loadTotal_kWh: number;
  pvTotal_kWh: number;
  loadFromGrid_kWh: number;
  loadFromBattery_kWh: number;
  loadFromPv_kWh: number;
  gridToBattery_kWh: number;
  batteryToGrid_kWh: number;
  importEnergy_kWh: number;
  avgImportPrice_cents_per_kWh: number | null;
  gridBatteryTippingPoint_cents_per_kWh: number | null;
  gridChargeTippingPoint_cents_per_kWh: number | null;
  batteryExportTippingPoint_cents_per_kWh: number | null;
  pvExportTippingPoint_cents_per_kWh: number | null;
  rebalanceStatus: 'disabled' | 'scheduled' | 'active';
}
