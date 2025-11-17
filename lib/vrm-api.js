/*

Minimal client for Victron VRM API

Example:

import { VRMClient } from './vrmApi.js';

const vrm = new VRMClient({
  baseURL: 'https://vrmapi.victronenergy.com',
  installationId: '123456',
  token: '<your-token-here>'
});

const settings = await vrm.fetchDynamicEssSettings();

const forecasts = await vrm.fetchForecasts(); // defaults to last full hour → next midnight
// forecasts.load_W, forecasts.pv_W, forecasts.timestamps

const prices = await vrm.fetchPrices();
// prices.importPrice_eur_per_kwh, prices.exportPrice_eur_per_kwh, ...

Optional: custom window
const win = VRMClient.windowLastHourToNextMidnightUTC();
const forecasts2 = await vrm.fetchForecasts(win);
----------------------------------------------------------------------------- */


export class VRMClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseURL - e.g. "https://vrmapi.victronenergy.com"
   * @param {string} opts.installationId - numeric idSite / installation id as string
   * @param {string} opts.token - VRM API token
   */
  constructor({ baseURL, installationId, token } = {}) {
    this.baseURL = (baseURL || 'https://vrmapi.victronenergy.com').replace(/\/+$/, '') + "/v2";
    this.installationId = installationId || '';
    this.token = token || '';
    this.defaultIntervalMins = 15;
  }

  setAuth({ installationId, token } = {}) {
    if (installationId != null) this.installationId = String(installationId);
    if (token != null) this.token = token;
  }

  setBaseURL(baseURL) {
    this.baseURL = String(baseURL || '').replace(/\/+$/, '') + "/v2";
  }

  // ----------------------------- Core fetch helper -----------------------------

  async _fetch(path, { query = {}, method = 'GET', body } = {}) {
    if (!this.token) throw new Error('Missing VRM API token');
    const url = new URL(this.baseURL + (path.startsWith('/') ? path : `/${path}`));
    Object.entries(query).forEach(([k, v]) => v != null && url.searchParams.set(k, String(v)));

    const headers = {
      'Accept': 'application/json',
      'X-Authorization': `Token ${this.token}`
    };
    const init = { method, headers };
    if (body != null) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url.toString(), init);
    if (!res.ok) {
      let txt = '';
      try { txt = await res.text(); } catch { /* ignore */ }
      throw new Error(`VRM ${res.status} ${res.statusText}: ${txt || 'Request failed'}`);
    }
    return res.json();
  }

  // ----------------------- Time-window helper utilities -----------------------

  /**
 * windowOptimizationHorizon()
 *
 * Build the [start, end) window we want to ask VRM for.
 *
 * Rules:
 * - Start: the last full local hour. Example: if it's 10:37, start = today 10:00 local.
 * - End:
 *     If local time < 13:00 → midnight tonight (start of tomorrow local day)
 *     Else                  → midnight tomorrow night (start of the day after tomorrow local day)
 *
 * Returned as both ms and sec (epoch-based, i.e. UTC timestamps).
 *
 * Why epoch-based? The VRM API wants `start`/`end` as seconds since epoch (UTC).
 * We do the time arithmetic in local time first — because "midnight" in your
 * billing world is local midnight — then call .getTime() to convert to UTC ms.
 */
  static windowOptimizationHorizon() {
    const nowLocal = new Date(); // browser local time
    const y = nowLocal.getFullYear();
    const m = nowLocal.getMonth();
    const d = nowLocal.getDate();
    const hr = nowLocal.getHours();

    // --- Start = last full hour local ---
    // e.g. if it's 10:37, this becomes today 10:00 local
    const startLocal = new Date(y, m, d, hr, 0, 0, 0);

    // --- End = local midnight depending on cutoff ---
    // Before 13:00 → up to midnight tonight (= start of tomorrow)
    // After / at 13:00 → up to midnight tomorrow (= start of day after tomorrow)
    const dayOffset = (hr < 13) ? 1 : 2;
    const endLocal = new Date(y, m, d + dayOffset, 0, 0, 0, 0);

    // Convert both local times to absolute UTC timestamps
    // Date.getTime() is ms since epoch in UTC.
    const startMs = startLocal.getTime();
    const endMs = endLocal.getTime();

    return {
      startMs,
      endMs,
      startSec: Math.floor(startMs / 1000),
      endSec: Math.floor(endMs / 1000)
    };
  }


  // Make a continuous 15-min timeline in [startMs, endMs)
  static buildTimeline15Min(startMs, endMs) {
    const step = 15 * 60 * 1000;
    const arr = [];
    for (let t = startMs; t < endMs; t += step) arr.push(t);
    return arr;
  }

  static toISO(ms) { return new Date(ms).toISOString(); }

  // ------------------------------ Settings (DESS) ------------------------------

  /**
   * GET /installations/{id}/dynamic-ess-settings
   * Normalizes key fields to W/Wh and €/kWh & c€/kWh.
   */
  async fetchDynamicEssSettings() {
    if (!this.installationId) throw new Error('Missing installationId');
    const data = await this._fetch(`/installations/${this.installationId}/dynamic-ess-settings`);
    if (!data?.success) throw new Error('dynamic-ess-settings: success=false');

    const d = data.data || {};
    // VRM returns: batteryCapacity (kWh), dischargePower (kW), chargePower (kW), maxPowerFromGrid (kW), maxPowerToGrid (kW), batteryCosts (€/kWh)
    const batteryCapacity_kWh = num(d.batteryCapacity);
    const settings = {
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
        alwaysApplyBatteryFlowRestriction: boolish(d.alwaysApplyBatteryFlowRestriction)
      },
      limits: {
        gridExportLimit_W: safeMul(num(d.gridExportLimit), 1000) || null,
        gridImportLimit_W: safeMul(num(d.gridImportLimit), 1000) || null,
        batteryChargeLimit_W: safeMul(num(d.batteryChargeLimit), 1000) || null,
        batteryDischargeLimit_W: safeMul(num(d.batteryDischargeLimit), 1000) || null
      },
      updatedOn: d.updatedOn || null,
      createdOn: d.createdOn || null
    };

    return settings;
  }

  /**
   * fetchMinSocLimit()
   *
   * GET /installations/{id}/dashboard
   *
   * Reads "ESS Minimum SOC (unless grid fails)" from:
   *   data.attributes.H4ms.rawValue
   *
   * Returns the value as a bounded percentage in [0, 100], or null if missing.
   */
  async fetchMinSocLimit() {
    if (!this.installationId) throw new Error('Missing installationId');

    const data = await this._fetch(`/installations/${this.installationId}/dashboard`);
    if (!data?.success) throw new Error('dashboard: success=false');

    const attr = data.attributes?.H4ms;
    if (!attr || typeof attr.rawValue !== 'number') {
      return {
        minSoc_pct: null,
        raw: data
      };
    }

    const v = Number(attr.rawValue);
    const bounded = Math.max(0, Math.min(100, v));

    return {
      minSoc_pct: bounded,
      raw: data
    };
  }


  // -------------------------- Forecasts (load + PV) ---------------------------

  /**
   * GET /installations/{id}/stats?type=forecast&interval=15mins&start=...&end=...
   * VRM returns hourly kWh values at the hour mark and zeros at the other 15-minute slots.
   * This converts each hourly kWh spike into a constant average power over that hour in W,
   * and fills all 4×15-min slots of the hour with that W.
   *
   * @param {{startSec?:number,endSec?:number,startMs?:number,endMs?:number}} [opts]
   * @returns {{
   *   step_minutes:number,
   *   timestamps:number[],          // ms since epoch
   *   timestamps_iso:string[],
   *   load_W:number[],
   *   pv_W:number[],
   *   raw:any
   * }}
   */
  async fetchForecasts(opts = {}) {
    if (!this.installationId) throw new Error('Missing installationId');

    const win = ensureWindow(opts);
    const q = {
      type: 'forecast',
      interval: '15mins',
      start: win.startSec,
      end: win.endSec
    };
    const data = await this._fetch(`/installations/${this.installationId}/stats`, { query: q });
    if (!data?.success) throw new Error('forecast stats: success=false');

    // Expected keys (from your examples):
    // - "vrm_consumption_fc": [[ms, W], ...]
    // - "solar_yield_forecast": [[ms, W], ...]
    const rec = data.records || {};
    const loadWSeries = toSeries(rec['vrm_consumption_fc']);   // ms -> W
    const pvWSeries = toSeries(rec['solar_yield_forecast']); // ms -> W

    const timeline = VRMClient.buildTimeline15Min(win.startMs, win.endMs);

    const load_W = fillHourlyWAcrossQuarterHours(loadWSeries, timeline);
    const pv_W = fillHourlyWAcrossQuarterHours(pvWSeries, timeline);

    return {
      step_minutes: 15,
      timestamps: timeline,
      timestamps_iso: timeline.map(VRMClient.toISO),
      load_W,
      pv_W,
      raw: data
    };
  }

  // ------------------------------- Prices (DESS) ------------------------------

  /**
   * GET /installations/{id}/stats?type=dynamic_ess_prices&interval=15mins&start=...&end=...
   * Keys:
   *   - deGb: buy prices (€/kWh) at every 15min slot
   *   - deGs: sell prices (€/kWh) at every 15min slot
   *
   * @param {{startSec?:number,endSec?:number,startMs?:number,endMs?:number}} [opts]
   * @returns {{
   *   step_minutes:number,
   *   timestamps:number[],
   *   timestamps_iso:string[],
   *   importPrice_eur_per_kwh:number[],
   *   exportPrice_eur_per_kwh:number[],
   *   importPrice_cents_per_kwh:number[],
   *   exportPrice_cents_per_kwh:number[],
   *   raw:any
   * }}
   */
  async fetchPrices(opts = {}) {
    if (!this.installationId) throw new Error('Missing installationId');

    const win = ensureWindow(opts);
    const q = {
      type: 'dynamic_ess_prices',
      interval: '15mins',
      start: win.startSec,
      end: win.endSec
    };
    const data = await this._fetch(`/installations/${this.installationId}/stats`, { query: q });
    if (!data?.success) throw new Error('prices stats: success=false');

    const rec = data.records || {};
    const buy = toSeries(rec['deGb']); // €/kWh
    const sell = toSeries(rec['deGs']); // €/kWh

    const timeline = VRMClient.buildTimeline15Min(win.startMs, win.endMs);
    const importPrice_eur_per_kwh = alignToTimeline(buy, timeline, 0);
    const exportPrice_eur_per_kwh = alignToTimeline(sell, timeline, 0);

    const importPrice_cents_per_kwh = importPrice_eur_per_kwh.map(v => v * 100);
    const exportPrice_cents_per_kwh = exportPrice_eur_per_kwh.map(v => v * 100);

    return {
      step_minutes: 15,
      timestamps: timeline,
      timestamps_iso: timeline.map(VRMClient.toISO),
      importPrice_eur_per_kwh,
      exportPrice_eur_per_kwh,
      importPrice_cents_per_kwh,
      exportPrice_cents_per_kwh,
      raw: data
    };
  }
}

/* ------------------------------- Helpers ------------------------------- */

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}
function safeMul(a, b) {
  const n = Number(a) * Number(b);
  return Number.isFinite(n) ? n : 0;
}
function boolish(v) { return v === true || v === 1 || v === '1'; }

/**
 * Ensure a valid start/end window, defaulting to last full hour → next midnight local time.
 */
function ensureWindow({ startSec, endSec, startMs, endMs } = {}) {
  if (startMs != null && endMs != null) {
    return {
      startMs,
      endMs,
      startSec: Math.floor(startMs / 1000),
      endSec: Math.floor(endMs / 1000)
    };
  }
  if (startSec != null && endSec != null) {
    return {
      startSec,
      endSec,
      startMs: startSec * 1000,
      endMs: endSec * 1000
    };
  }
  // default: build horizon based on local time + 13:00 rule
  return VRMClient.windowOptimizationHorizon();
}

/**
 * Convert VRM stats array [[ms,value], ...] to a Map(ms -> value).
 */
function toSeries(arr) {
  const map = new Map();
  if (Array.isArray(arr)) {
    for (const row of arr) {
      if (Array.isArray(row) && row.length >= 2) {
        const t = Number(row[0]);
        const v = Number(row[1]);
        if (Number.isFinite(t) && Number.isFinite(v)) map.set(t, v);
      }
    }
  }
  return map;
}

/**
 * Align a (ms -> value) map to a fixed ms timeline, filling missing with fallback.
 */
function alignToTimeline(seriesMap, timeline, fallback = 0) {
  return timeline.map(ms => (seriesMap.has(ms) ? Number(seriesMap.get(ms)) : fallback));
}

/**
 * Forecast series are given as **W at the full hour** (non-zero only on hh:00) and zeros elsewhere.
 * Fill each hour's 4 quarter-hours with that **W**.
 */
function fillHourlyWAcrossQuarterHours(seriesMap, timeline) {
  const result = new Array(timeline.length).fill(0);

  let currentHourStart = null;
  let currentHourW = 0;

  for (let i = 0; i < timeline.length; i++) {
    const t = timeline[i];

    const date = new Date(t);
    const hourStart = Date.UTC(
      date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(),
      date.getUTCHours(), 0, 0, 0
    );

    if (hourStart !== currentHourStart) {
      currentHourStart = hourStart;
      const w = seriesMap.get(hourStart); // value is already Watts at hour start
      currentHourW = (Number.isFinite(w) && w > 0) ? Number(w) : 0;
    }

    result[i] = currentHourW;
  }

  return result;
}
