import { HttpError } from '../http-errors.js';
import { loadSettings } from './settings-store.js';
import { loadData } from './data-store.js';
import { extractWindow, getQuarterStart } from '../../lib/time-series-utils.js';

// Clamp x/100 into [0,1], handling junk defensively
function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function numOrThrow(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new HttpError(500, `Invalid numeric setting: ${field}`);
  }
  return n;
}

/**
 * Calculates the end timestamp (ms) of a time series object.
 * Assumes source has { start: ISOString|number, step: number, values: number[] }
 */
function getSeriesEndMs(source) {
  if (!source || !source.start || !Array.isArray(source.values)) return 0;
  const startMs = new Date(source.start).getTime();
  const stepMs = (source.step || 15) * 60 * 1000;
  return startMs + source.values.length * stepMs;
}

// Build the LP config expected by lib/build-lp.js from settings + data.
// Throws 422 when arrays are missing/empty or lengths mismatch.
export function buildSolverConfigFromSettings(settings, data = {}) {
  // Scalars (settings are already merged with defaults by settings-store)
  const stepSize_m = numOrThrow(settings.stepSize_m, 'stepSize_m');

  const batteryCapacity_Wh = numOrThrow(settings.batteryCapacity_Wh, 'batteryCapacity_Wh');
  const minSoc_percent = numOrThrow(settings.minSoc_percent, 'minSoc_percent');
  const maxSoc_percent = numOrThrow(settings.maxSoc_percent, 'maxSoc_percent');
  const maxChargePower_W = numOrThrow(settings.maxChargePower_W, 'maxChargePower_W');
  const maxDischargePower_W = numOrThrow(settings.maxDischargePower_W, 'maxDischargePower_W');
  const maxGridImport_W = numOrThrow(settings.maxGridImport_W, 'maxGridImport_W');
  const maxGridExport_W = numOrThrow(settings.maxGridExport_W, 'maxGridExport_W');
  const chargeEfficiency_percent = numOrThrow(settings.chargeEfficiency_percent, 'chargeEfficiency_percent');
  const dischargeEfficiency_percent = numOrThrow(settings.dischargeEfficiency_percent, 'dischargeEfficiency_percent');
  const batteryCost_cent_per_kWh = numOrThrow(settings.batteryCost_cent_per_kWh, 'batteryCost_cent_per_kWh');

  const terminalSocValuation = settings.terminalSocValuation;
  if (typeof terminalSocValuation !== 'string' || !terminalSocValuation) {
    throw new HttpError(500, 'Invalid setting: terminalSocValuation');
  }
  const terminalSocCustomPrice_cents_per_kWh =
    Number(settings.terminalSocCustomPrice_cents_per_kWh ?? 0);

  // Check for legacy data format
  if (data.load_W || data.pv_W || data.tsStart) {
    throw new HttpError(422, 'Data file format is outdated (legacy keys detected: load_W/pv_W/tsStart). Please refresh data from VRM.', {
      suggestion: 'Run POST /calculate with { "updateData": true } or delete data.json'
    });
  }

  // Validate new structure presence
  if (!data.load || !data.pv || !data.importPrice || !data.exportPrice) {
    throw new HttpError(500, 'Invalid data structure: missing required time series objects (load/pv/importPrice/exportPrice).');
  }

  const nowMs = getQuarterStart(new Date(), settings.stepSize_m);

  // Determine availability of each stream
  // data structure: { load: {...}, pv: {...}, importPrice: {...}, exportPrice: {...}, soc: {...} }
  const loadEndMs = getSeriesEndMs(data.load);
  const pvEndMs = getSeriesEndMs(data.pv);
  const importEndMs = getSeriesEndMs(data.importPrice);
  const exportEndMs = getSeriesEndMs(data.exportPrice);

  // The horizon ends at the earliest end time of any required stream
  const endMs = Math.min(loadEndMs, pvEndMs, importEndMs, exportEndMs);

  if (endMs <= nowMs) {
    throw new HttpError(422, 'Insufficient future data', {
      details: {
        now: new Date(nowMs).toISOString(),
        loadEnd: new Date(loadEndMs).toISOString(),
        pvEnd: new Date(pvEndMs).toISOString(),
        importEnd: new Date(importEndMs).toISOString(),
        exportEnd: new Date(exportEndMs).toISOString(),
      },
    });
  }

  // Extract aligned windows
  const load_W = extractWindow(data.load, nowMs, endMs);
  const pv_W = extractWindow(data.pv, nowMs, endMs);
  const importPrice = extractWindow(data.importPrice, nowMs, endMs);
  const exportPrice = extractWindow(data.exportPrice, nowMs, endMs);

  // Initial SoC from data
  // New structure: data.soc = { timestamp: "...", value: 50 }
  // Old structure compatible fallback: data.initialSoc_percent
  let initialSoc_percent = data.soc?.value ?? data.initialSoc_percent;
  initialSoc_percent = Number(initialSoc_percent);

  if (!Number.isFinite(initialSoc_percent)) {
    throw new HttpError(
      422,
      'initialSoc_percent missing in data; refresh VRM time series first',
    );
  }

  const cfg = {
    // arrays
    load_W,
    pv_W,
    importPrice,
    exportPrice,

    // scalars
    stepSize_m,
    batteryCapacity_Wh,
    minSoc_percent,
    maxSoc_percent,
    maxChargePower_W,
    maxDischargePower_W,
    maxGridImport_W,
    maxGridExport_W,
    chargeEfficiency_percent,
    dischargeEfficiency_percent,
    batteryCost_cent_per_kWh,

    terminalSocValuation,
    terminalSocCustomPrice_cents_per_kWh,

    initialSoc_percent,
  };

  // Sanity: clamp min/max SOC to [0,100], ensure min <= max
  cfg.minSoc_percent = Math.round(100 * clamp01(cfg.minSoc_percent / 100));
  cfg.maxSoc_percent = Math.round(100 * clamp01(cfg.maxSoc_percent / 100));
  if (cfg.maxSoc_percent < cfg.minSoc_percent) {
    const tmp = cfg.minSoc_percent;
    cfg.minSoc_percent = cfg.maxSoc_percent;
    cfg.maxSoc_percent = tmp;
  }

  return cfg;
}

// Timeline info derived from dynamic calculation
export function getTimingData(settings, data = {}) {
  const stepMin = numOrThrow(settings.stepSize_m, 'stepSize_m');
  const nowMs = getQuarterStart(new Date(), stepMin);

  // We could return just "now" as start, since data is aligned to it.
  return { startMs: nowMs, stepMin };
}

export async function getSolverInputs() {
  const [settings, data] = await Promise.all([loadSettings(), loadData()]);
  const cfg = buildSolverConfigFromSettings(settings, data);
  const timing = getTimingData(settings, data);
  return { cfg, timing, data };
}
