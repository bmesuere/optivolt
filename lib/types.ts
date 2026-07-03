/**
 * Shared type definitions for the OptiVolt solver pipeline.
 */

export type TerminalSocValuation = 'zero' | 'min' | 'avg' | 'max' | 'custom';

/**
 * How HA should control the charger for a given slot:
 *   fixed      — set exactly ev_charge_A amps (charger is at minimum rate; can't track dynamically)
 *   solar_only — track actual PV surplus only; may turn off if PV drops below minimum
 *   solar_grid — track PV surplus + grid headroom; no battery draw (covers grid-only slots too)
 *   max        — charge at maximum amps using all available sources (battery involved)
 *   off        — no charging
 */
export type EvChargeMode = 'off' | 'fixed' | 'solar_only' | 'solar_grid' | 'max';

/**
 * A window during which the EV is plugged in and available to charge, as the
 * half-open slot range [startSlot, endSlot). Outside every window the EV is
 * forced off (charging held at zero, SoC flat). The builder emits a single
 * window today; the array form is forward-compatible with future multiple
 * arrival/departure windows and recurring schedules.
 */
export interface EvAvailabilityWindow {
  /** Inclusive first available slot, clamped to [0, T]. */
  startSlot: number;
  /** Exclusive last available slot, clamped to [startSlot, T]. */
  endSlot: number;
  /**
   * SoC (Wh) assumed at startSlot, anchoring the SoC chain for this window.
   * Today only the first window sets this (= the arrival SoC). A future window
   * modelling a return trip would reset it; undefined means SoC carries over
   * from the previous slot.
   */
  resetSoc_Wh?: number;
}

/** A SoC deadline: ev_soc must be at least soc_Wh by slot. */
export interface EvSocTarget {
  /** 0-based slot index at which the constraint is pinned. */
  slot: number;
  /** Required minimum SoC at that slot, in Wh. */
  soc_Wh: number;
}

export interface EvConfig {
  evMinChargePower_W: number;
  evMaxChargePower_W: number;
  evBatteryCapacity_Wh: number;
  evInitialSoc_percent: number;
  /** AC-to-DC efficiency of the EV's onboard charger, as a percentage (e.g. 90 = 90%). */
  evChargeEfficiency_percent: number;
  /** Availability windows; charging is forced off outside all of them. */
  availabilityWindows: EvAvailabilityWindow[];
  /** SoC deadlines layered onto the plan. Empty means no enforced target (latent charging only). */
  targets: EvSocTarget[];
}

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

  // EV SoC valuation (value of energy left in the EV battery, c€/kWh; 0 = disabled)
  evSocValue_cents_per_kWh: number;

  // Initial state
  initialSoc_percent: number;

  // Rebalancing (optional — only present when rebalanceEnabled is true)
  rebalanceHoldSlots?: number;
  rebalanceRemainingSlots?: number;
  rebalanceTargetSoc_percent?: number;

  // EV charging (optional — only present when evEnabled is true and EV is plugged in)
  ev?: EvConfig;
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
  originalLoad?: number; // unadjusted prediction W when a manual adjustment changed the slot
  originalPv?: number;   // unadjusted prediction W when a manual adjustment changed the slot
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
  importCost_cents: number;  // import energy cost for this slot, in c€
  exportCost_cents: number;  // export energy value for this slot, in c€
  soc: number;   // battery SoC Wh
  soc_percent: number;  // battery SoC %
  g2ev: number;         // grid → EV W
  pv2ev: number;        // PV → EV W
  b2ev: number;         // battery → EV W
  ev_charge: number;    // total EV charge power W
  ev_charge_A: number;  // charge current A (ev_charge / 230 / phases)
  ev_charge_mode: EvChargeMode;
  ev_soc_percent: number;  // EV SoC %
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
  importCost_cents: number;
  exportCost_cents: number;
  netGridCost_cents: number;
  avgImportPrice_cents_per_kWh: number | null;
  gridBatteryTippingPoint_cents_per_kWh: number | null;
  gridChargeTippingPoint_cents_per_kWh: number | null;
  batteryExportTippingPoint_cents_per_kWh: number | null;
  pvExportTippingPoint_cents_per_kWh: number | null;
  rebalanceStatus: 'disabled' | 'scheduled' | 'active';
  evChargeTotal_kWh: number;
  evChargeFromGrid_kWh: number;
  evChargeFromPv_kWh: number;
  evChargeFromBattery_kWh: number;
}
