import { HttpError } from '../http-errors.js';
import { loadSettings } from './settings-store.js';

// Clamp x/100 into [0,1], handling junk defensively
function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function ensureNumArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(Number).filter(Number.isFinite);
}

// Build the LP config expected by lib/build-lp.js from settings (arrays only).
// Throws 422 when arrays are missing/empty or lengths mismatch.
export function buildSolverConfigFromSettings(settings) {
  const stepSize_m = Number(settings.stepSize_m) || 15;

  const load_W = ensureNumArray(settings.load_W);
  const pv_W = ensureNumArray(settings.pv_W);
  const importPrice = ensureNumArray(settings.importPrice);
  const exportPrice = ensureNumArray(settings.exportPrice);

  const T = Math.min(load_W.length, pv_W.length, importPrice.length, exportPrice.length);
  if (!T) {
    throw new HttpError(422, 'Time series are missing or empty', {
      details: {
        load: load_W.length,
        pv: pv_W.length,
        importPrice: importPrice.length,
        exportPrice: exportPrice.length,
      },
    });
  }

  const trim = (arr) => arr.slice(0, T);

  const cfg = {
    // arrays
    load_W: trim(load_W),
    pv_W: trim(pv_W),
    importPrice: trim(importPrice),
    exportPrice: trim(exportPrice),

    // scalars (defaults already injected by loadSettings() via default-settings.json)
    stepSize_m,
    batteryCapacity_Wh: Number(settings.batteryCapacity_Wh),
    minSoc_percent: Number(settings.minSoc_percent),
    maxSoc_percent: Number(settings.maxSoc_percent),
    maxChargePower_W: Number(settings.maxChargePower_W),
    maxDischargePower_W: Number(settings.maxDischargePower_W),
    maxGridImport_W: Number(settings.maxGridImport_W),
    maxGridExport_W: Number(settings.maxGridExport_W),
    chargeEfficiency_percent: Number(settings.chargeEfficiency_percent),
    dischargeEfficiency_percent: Number(settings.dischargeEfficiency_percent),
    batteryCost_cent_per_kWh: Number(settings.batteryCost_cent_per_kWh),

    terminalSocValuation: settings.terminalSocValuation || "zero",
    terminalSocCustomPrice_cents_per_kWh: Number(settings.terminalSocCustomPrice_cents_per_kWh),

    initialSoc_percent: Number(settings.initialSoc_percent),
  };

  // Sanity: clamp min/max SOC to [0,100], ensure min<=max
  cfg.minSoc_percent = Math.round(100 * clamp01(cfg.minSoc_percent / 100));
  cfg.maxSoc_percent = Math.round(100 * clamp01(cfg.maxSoc_percent / 100));
  if (cfg.maxSoc_percent < cfg.minSoc_percent) {
    const tmp = cfg.minSoc_percent;
    cfg.minSoc_percent = cfg.maxSoc_percent;
    cfg.maxSoc_percent = tmp;
  }

  return cfg;
}

// Optional timing hints: derive from settings.tsStart + step
export function timingHintsFromSettings(settings) {
  const hints = {};
  if (typeof settings.tsStart === 'string' && settings.tsStart.trim()) {
    const ms = new Date(settings.tsStart.trim()).getTime();
    if (Number.isFinite(ms)) hints.startMs = ms;
  }
  const stepMin = Number(settings.stepSize_m);
  if (Number.isFinite(stepMin) && stepMin > 0) hints.stepMin = stepMin;
  return hints;
}

export async function getEffectiveConfigAndHints() {
  const settings = await loadSettings();
  const cfg = buildSolverConfigFromSettings(settings);
  const hints = timingHintsFromSettings(settings);
  return { cfg, hints };
}
