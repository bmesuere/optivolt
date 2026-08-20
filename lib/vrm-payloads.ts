/**
 * vrm-payloads.ts
 *
 * Pure window math and response parsers for the Victron VRM API.
 * No I/O — the HTTP client lives in api/services/vrm-client.ts.
 */

import { dayAheadWindowEndMs } from './time-series-utils.ts';

export interface VRMWindow {
  startMs: number;
  endMs: number;
  startSec: number;
  endSec: number;
}

export interface VRMDessFlags {
  isOn: boolean;
  isGreenModeOn: boolean;
  isPeriodicFullChargeOn: boolean;
  alwaysApplyBatteryFlowRestriction: boolean;
}

export interface VRMDessLimits {
  gridExportLimit_W: number | null;
  gridImportLimit_W: number | null;
  batteryChargeLimit_W: number | null;
  batteryDischargeLimit_W: number | null;
}

export interface VRMDessSettings {
  raw: unknown;
  idSite: unknown;
  gridSell: boolean;
  batteryCapacity_kWh: number;
  batteryCapacity_Wh: number;
  dischargePower_W: number;
  chargePower_W: number;
  maxPowerFromGrid_W: number;
  maxPowerToGrid_W: number;
  batteryCosts_eur_per_kWh: number;
  batteryCosts_cents_per_kWh: number;
  batteryFlowRestriction: unknown;
  buyPriceFormula: unknown;
  sellPriceFormula: unknown;
  biddingZoneCode: unknown;
  buyPriceSamplingRate_mins: number | null;
  sellPriceSamplingRate_mins: number | null;
  flags: VRMDessFlags;
  limits: VRMDessLimits;
  updatedOn: string | null;
  createdOn: string | null;
}

export interface VRMForecasts {
  step_minutes: number;
  timestamps: number[];
  timestamps_iso: string[];
  load_W: number[];
  pv_W: number[];
  raw: unknown;
}

export interface VRMPrices {
  step_minutes: number;
  timestamps: number[];
  timestamps_iso: string[];
  importPrice_eur_per_kwh: number[];
  exportPrice_eur_per_kwh: number[];
  importPrice_cents_per_kwh: number[];
  exportPrice_cents_per_kwh: number[];
  raw: unknown;
}

interface StatsResponse {
  success?: boolean;
  records?: Record<string, [number, number][]>;
}

/* --------------------------- Time-window helpers --------------------------- */

/**
 * Build the [start, end) window we want to ask VRM for.
 *
 * - Start: the last full local hour. Example: if it's 10:37, start = today 10:00 local.
 * - End: the day-ahead window end (local midnight, 13:00 rule), pushed out by
 *   `extraDays` for the extended horizon.
 *
 * Returned as both ms and sec (epoch-based, i.e. UTC timestamps) because the
 * VRM API wants `start`/`end` as seconds since epoch.
 */
export function windowOptimizationHorizon(extraDays = 0, nowMs = Date.now()): VRMWindow {
  const now = new Date(nowMs);
  const startMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0, 0).getTime();
  return toWindow(startMs, dayAheadWindowEndMs(nowMs, extraDays));
}

/**
 * Ensure a valid start/end window, defaulting to the standard optimization horizon.
 */
export function ensureWindow({ startSec, endSec, startMs, endMs }: Partial<VRMWindow> = {}, nowMs = Date.now()): VRMWindow {
  if (startMs != null && endMs != null) return toWindow(startMs, endMs);
  if (startSec != null && endSec != null) {
    return { startSec, endSec, startMs: startSec * 1000, endMs: endSec * 1000 };
  }
  return windowOptimizationHorizon(0, nowMs);
}

function toWindow(startMs: number, endMs: number): VRMWindow {
  return { startMs, endMs, startSec: Math.floor(startMs / 1000), endSec: Math.floor(endMs / 1000) };
}

/** Continuous 15-min timeline covering [startMs, endMs). */
export function buildTimeline15Min(startMs: number, endMs: number): number[] {
  const step = 15 * 60 * 1000;
  const arr: number[] = [];
  for (let t = startMs; t < endMs; t += step) arr.push(t);
  return arr;
}

export function toISO(ms: number): string { return new Date(ms).toISOString(); }

/* ------------------------------ Response parsers ---------------------------- */

/**
 * Parse GET /installations/{id}/dynamic-ess-settings.
 * VRM returns kW / kWh / €; this normalizes to W/Wh and €/kWh & c€/kWh.
 */
export function parseDessSettings(payload: unknown): VRMDessSettings {
  const data = payload as { success?: boolean; data?: Record<string, unknown> } | null;
  if (!data?.success) throw new Error('dynamic-ess-settings: success=false');

  const d = data.data || {};
  const batteryCapacity_kWh = num(d.batteryCapacity);
  return {
    raw: d,
    idSite: d.idSite,
    gridSell: boolish(d.gridSell),
    batteryCapacity_kWh,
    batteryCapacity_Wh: safeMul(batteryCapacity_kWh, 1000),
    dischargePower_W: safeMul(num(d.dischargePower), 1000),
    chargePower_W: safeMul(num(d.chargePower), 1000),
    maxPowerFromGrid_W: safeMul(num(d.maxPowerFromGrid), 1000),
    maxPowerToGrid_W: safeMul(num(d.maxPowerToGrid), 1000),
    batteryCosts_eur_per_kWh: num(d.batteryCosts),
    batteryCosts_cents_per_kWh: safeMul(num(d.batteryCosts), 100),
    batteryFlowRestriction: d.batteryFlowRestriction ?? null,
    buyPriceFormula: d.buyPriceFormula ?? null,
    sellPriceFormula: d.sellPriceFormula ?? null,
    biddingZoneCode: d.biddingZoneCode ?? null,
    buyPriceSamplingRate_mins: num(d.buyPriceSamplingRate) || null,
    sellPriceSamplingRate_mins: num(d.sellPriceSamplingRate) || null,
    flags: {
      isOn: boolish(d.isOn),
      isGreenModeOn: boolish(d.isGreenModeOn),
      isPeriodicFullChargeOn: boolish(d.isPeriodicFullChargeOn),
      alwaysApplyBatteryFlowRestriction: boolish(d.alwaysApplyBatteryFlowRestriction),
    },
    limits: {
      gridExportLimit_W: safeMul(num(d.gridExportLimit), 1000) || null,
      gridImportLimit_W: safeMul(num(d.gridImportLimit), 1000) || null,
      batteryChargeLimit_W: safeMul(num(d.batteryChargeLimit), 1000) || null,
      batteryDischargeLimit_W: safeMul(num(d.batteryDischargeLimit), 1000) || null,
    },
    updatedOn: (d.updatedOn as string) || null,
    createdOn: (d.createdOn as string) || null,
  };
}

/**
 * Parse a `type=forecast` stats response onto a 15-min timeline.
 * VRM returns hourly W values at the hour mark and zeros at the other 15-minute
 * slots; each hour's value is spread across all four of its quarter-hours.
 */
export function parseForecastsResponse(
  payload: unknown,
  win: VRMWindow,
  { clampEndToData = false } = {},
): VRMForecasts {
  const data = payload as StatsResponse | null;
  if (!data?.success) throw new Error('forecast stats: success=false');

  const rec = data.records || {};
  const loadWSeries = toSeries(rec['vrm_consumption_fc']);   // ms -> W
  const pvWSeries = toSeries(rec['solar_yield_forecast']);   // ms -> W

  // When a window beyond VRM's own horizon is requested, truncate at the
  // last returned LOAD data point (+1h, values are hourly): slots past that
  // would be zero-filled, and zero load reads as "free energy" to the
  // solver. PV coverage deliberately doesn't count — missing PV is safely
  // zero (no sun), but a PV series outlasting load must not stretch the
  // timeline over fabricated zero-load hours. No load data at all yields an
  // empty timeline, which callers treat as a failed fetch (previous data is
  // kept) rather than an all-zero forecast.
  let endMs = win.endMs;
  if (clampEndToData) {
    endMs = loadWSeries.size > 0
      ? Math.min(endMs, Math.max(...loadWSeries.keys()) + 3_600_000)
      : win.startMs;
  }

  const timeline = buildTimeline15Min(win.startMs, endMs);

  return {
    step_minutes: 15,
    timestamps: timeline,
    timestamps_iso: timeline.map(toISO),
    load_W: fillHourlyWAcrossQuarterHours(loadWSeries, timeline),
    pv_W: fillHourlyWAcrossQuarterHours(pvWSeries, timeline),
    raw: data,
  };
}

/**
 * Parse a `type=dynamic_ess_prices` stats response onto a 15-min timeline.
 * Keys: deGb = buy prices (€/kWh), deGs = sell prices (€/kWh).
 */
export function parsePricesResponse(payload: unknown, win: VRMWindow): VRMPrices {
  const data = payload as StatsResponse | null;
  if (!data?.success) throw new Error('prices stats: success=false');

  const rec = data.records || {};
  const timeline = buildTimeline15Min(win.startMs, win.endMs);
  const importPrice_eur_per_kwh = alignToTimeline(toSeries(rec['deGb']), timeline);
  const exportPrice_eur_per_kwh = alignToTimeline(toSeries(rec['deGs']), timeline);

  return {
    step_minutes: 15,
    timestamps: timeline,
    timestamps_iso: timeline.map(toISO),
    importPrice_eur_per_kwh,
    exportPrice_eur_per_kwh,
    importPrice_cents_per_kwh: importPrice_eur_per_kwh.map(v => v * 100),
    exportPrice_cents_per_kwh: exportPrice_eur_per_kwh.map(v => v * 100),
    raw: data,
  };
}

/* --------------------------------- Helpers --------------------------------- */

function num(x: unknown): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function safeMul(a: number, b: number): number {
  const n = a * b;
  return Number.isFinite(n) ? n : 0;
}

function boolish(v: unknown): boolean { return v === true || v === 1 || v === '1'; }

/** Convert a VRM stats array [[ms, value], ...] to a Map(ms -> value). */
function toSeries(arr: [number, number][] | undefined): Map<number, number> {
  const map = new Map<number, number>();
  if (arr) {
    for (const [t, v] of arr) {
      if (Number.isFinite(t) && Number.isFinite(v)) map.set(t, v);
    }
  }
  return map;
}

/** Align a (ms -> value) map to a fixed ms timeline, filling missing with fallback. */
function alignToTimeline(seriesMap: Map<number, number>, timeline: number[], fallback = 0): number[] {
  return timeline.map(ms => seriesMap.get(ms) ?? fallback);
}

/**
 * Forecast series are given as **W at the full hour** (non-zero only on hh:00)
 * and zeros elsewhere. Fill each hour's 4 quarter-hours with that **W**.
 */
function fillHourlyWAcrossQuarterHours(seriesMap: Map<number, number>, timeline: number[]): number[] {
  const result = new Array<number>(timeline.length).fill(0);

  let currentHourStart: number | null = null;
  let currentHourW = 0;

  for (let i = 0; i < timeline.length; i++) {
    const date = new Date(timeline[i]);
    const hourStart = Date.UTC(
      date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(),
      date.getUTCHours(), 0, 0, 0,
    );

    if (hourStart !== currentHourStart) {
      currentHourStart = hourStart;
      const w = seriesMap.get(hourStart); // value is already Watts at hour start
      currentHourW = (w !== undefined && Number.isFinite(w) && w > 0) ? w : 0;
    }

    result[i] = currentHourW;
  }

  return result;
}
