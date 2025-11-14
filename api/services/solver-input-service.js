import { HttpError } from '../http-errors.js';
import { loadSettings } from './settings-store.js';
import { loadData } from './data-store.js';

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

function ensureNumArray(value, field) {
  if (!Array.isArray(value)) {
    throw new HttpError(422, `Missing time series in data: ${field}`);
  }

  const out = new Array(value.length);
  for (let i = 0; i < value.length; i++) {
    const n = Number(value[i]);
    if (!Number.isFinite(n)) {
      throw new HttpError(422, `Non-numeric value in ${field}[${i}]`);
    }
    out[i] = n;
  }
  return out;
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

  // Time series come purely from the data layer
  const load_W = ensureNumArray(data.load_W, 'load_W');
  const pv_W = ensureNumArray(data.pv_W, 'pv_W');
  const importPrice = ensureNumArray(data.importPrice, 'importPrice');
  const exportPrice = ensureNumArray(data.exportPrice, 'exportPrice');

  // Require equal lengths; don't silently trim
  const len = load_W.length;
  if (!len) {
    throw new HttpError(422, 'Time series are empty', {
      details: {
        load_W: load_W.length,
        pv_W: pv_W.length,
        importPrice: importPrice.length,
        exportPrice: exportPrice.length,
      },
    });
  }

  if (
    pv_W.length !== len ||
    importPrice.length !== len ||
    exportPrice.length !== len
  ) {
    throw new HttpError(422, 'Time series lengths mismatch', {
      details: {
        load_W: load_W.length,
        pv_W: pv_W.length,
        importPrice: importPrice.length,
        exportPrice: exportPrice.length,
      },
    });
  }

  // initial SoC is *only* allowed to come from data
  const initialSoc_percent = Number(data.initialSoc_percent);
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

// Timeline info derived from data.tsStart + settings.stepSize_m
export function buildTimelineHints(settings, data = {}) {
  const stepMin = numOrThrow(settings.stepSize_m, 'stepSize_m');

  const rawTs =
    typeof data.tsStart === 'string' ? data.tsStart.trim() : null;

  if (!rawTs) {
    throw new HttpError(
      422,
      'tsStart missing in data; refresh VRM time series first',
    );
  }

  const ms = Date.parse(rawTs);
  if (!Number.isFinite(ms)) {
    throw new HttpError(422, `Invalid tsStart in data: ${rawTs}`);
  }

  return { startMs: ms, stepMin };
}

export async function getSolverInputs() {
  const [settings, data] = await Promise.all([loadSettings(), loadData()]);
  const cfg = buildSolverConfigFromSettings(settings, data);
  const hints = buildTimelineHints(settings, data);
  return { cfg, hints, data };
}
