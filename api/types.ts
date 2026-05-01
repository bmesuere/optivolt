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
  evDepartureTime: string;
  evTargetSoc_percent: number;
  evChargeEfficiency_percent: number;
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

export interface Data {
  load: TimeSeries;
  pv: TimeSeries;
  importPrice: TimeSeries;
  exportPrice: TimeSeries;
  soc: SocData;
  rebalanceState?: RebalanceState;
  predictionAdjustments?: PredictionAdjustment[];
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

export interface PvPredictionConfig {
  latitude: number;
  longitude: number;
  historyDays: number;
  pvSensor: string;
  pvMode?: PvMode;
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
}
