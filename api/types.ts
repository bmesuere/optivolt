import type { TimeSeries, PlanRow, DessSlot, TerminalSocValuation } from '../lib/types.ts';
import type { DayFilter, Aggregation } from '../lib/load-predictor-historical.ts';
import type { HaSensor, HaDerivedSensor } from '../lib/ha-postprocess.ts';

export type { TimeSeries };

// Re-export HA types used by prediction config
export type { HaSensor, HaDerivedSensor };

// ----------------------------- Data sources -----------------------------

export type DataSource = 'vrm' | 'api';
export type SocSource = 'mqtt' | 'api';

export interface DataSources {
  load: DataSource;
  pv: DataSource;
  prices: DataSource;
  soc: SocSource;
}

// ----------------------------- Settings ---------------------------------

export interface Settings {
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
  blockFeedInOnNegativePrices: boolean;
  terminalSocValuation: TerminalSocValuation;
  terminalSocCustomPrice_cents_per_kWh: number;
  optimizerQuickSettings: string[];
  dataSources: DataSources;
  rebalanceEnabled: boolean;
  rebalanceHoldHours: number;
  haUrl: string;
  haToken: string;
  evEnabled: boolean;
  evMinChargeCurrent_A: number;
  evMaxChargeCurrent_A: number;
  evBatteryCapacity_kWh: number;
  evSocSensor: string;
  evPlugSensor: string;
  evChargeEfficiency_percent: number;
  evSocValue_cents_per_kWh: number;
  evTripSocBuffer_percent: number;
  /** Extra planning days beyond the standard day-ahead window. 0 = off (default behaviour). */
  extendedHorizonDays: number;
  /** URL of a price-forecast JSON feed (energieprijs forecast.json format). Empty = disabled. */
  priceForecastUrl: string;
}

// ----------------------------- Persisted data ---------------------------

export interface SocData {
  timestamp: string;
  value: number;
}

export interface RebalanceState {
  startMs: number | null;
}

export type PredictionAdjustmentSeries = 'load' | 'pv';
export type PredictionAdjustmentMode = 'set' | 'add';

export interface PredictionAdjustment {
  id: string;
  series: PredictionAdjustmentSeries;
  mode: PredictionAdjustmentMode;
  value_W: number;
  start: string;
  end: string;
  label?: string;
  createdAt: string;
  updatedAt: string;
}

export type EvScheduleEntryType = 'arrival' | 'departure' | 'target' | 'trip';

export interface EvScheduleEntry {
  id: string;
  type: EvScheduleEntryType;
  /** Arrival/departure/target: the event time. Trip: the departure time. */
  time: string;
  /** Arrival: assumed SoC on arrival. Departure: optional target SoC at departure. Target: required SoC. */
  soc_percent?: number;
  /** Trip only: the arrival (return) time; required, strictly after `time`. */
  endTime?: string;
  /** Trip only: estimated share of the EV battery consumed by the trip, in [0, 100]. */
  usage_percent?: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Last observed EV state, persisted so entry pruning / trip conversion can reason about the car
 * without a live Home Assistant round-trip. `soc_percent` is the last SoC seen while the car was
 * plugged in (the best "SoC at unplug" estimate once it leaves), not necessarily the current one.
 */
export interface EvLastState {
  pluggedIn: boolean;
  soc_percent: number | null;
  observedAt: string;
}

export interface Data {
  load: TimeSeries;
  pv: TimeSeries;
  importPrice: TimeSeries;
  exportPrice: TimeSeries;
  /** Forecast prices pulled from priceForecastUrl; only extend the actual series, never override it. */
  importPriceForecast?: TimeSeries;
  exportPriceForecast?: TimeSeries;
  soc: SocData;
  lastFullSocAt?: string | null;
  rebalanceState?: RebalanceState;
  predictionAdjustments?: PredictionAdjustment[];
  evScheduleEntries?: EvScheduleEntry[];
  evLastState?: EvLastState;
}

// ----------------------------- Plan rows with DESS ----------------------

export interface PlanRowWithDess extends PlanRow {
  dess: DessSlot;
}

// ----------------------------- Prediction config ------------------------

export interface PredictionValidationWindow {
  start: string;
  end: string;
}

/** Prediction mode for PV forecasting. Replaces the deprecated forecastResolution field. */
export type PvMode = 'hourly' | 'hybrid' | '15min';
export type PvModel = 'clearSkyRatio' | 'robustLinear';

export interface PvPredictionConfig {
  latitude: number;
  longitude: number;
  historyDays: number;
  pvSensor: string;
  pvMode?: PvMode;
  pvModel?: PvModel;
  /** @deprecated Use pvMode instead. 60 → 'hourly', 15 → 'hybrid'. */
  forecastResolution?: 15 | 60;
}

export interface PredictionConfig {
  sensors: HaSensor[];
  derived: HaDerivedSensor[];
  activeType?: 'historical' | 'fixed';
  historicalPredictor?: { sensor: string; lookbackWeeks: number; dayFilter: DayFilter; aggregation: Aggregation };
  fixedPredictor?: { load_W: number };
  validationWindow?: PredictionValidationWindow;
  includeRecent?: boolean;
  pvConfig?: PvPredictionConfig;
}

/** PredictionConfig enriched with HA credentials from Settings, passed to prediction services. */
export interface PredictionRunConfig extends PredictionConfig {
  haUrl: string;
  haToken: string;
  /** Extra forecast days beyond the standard window (from Settings.extendedHorizonDays). */
  extendedHorizonDays?: number;
}
