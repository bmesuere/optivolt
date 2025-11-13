import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from '../http-errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Allow overriding via env (e.g. Home Assistant mounts persistent state at /data)
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.resolve(__dirname, '../../data'));
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const DEFAULT_PATH = path.resolve(__dirname, '../../lib/default-settings.json');

async function readJson(filePath) {
  const data = await fs.readFile(filePath, 'utf8');
  return JSON.parse(data);
}

// Load stored settings or fall back to defaults (same logic as /settings route)
export async function loadSettings() {
  try {
    return await readJson(SETTINGS_PATH);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    return readJson(DEFAULT_PATH);
  }
}

// Parses numbers from either an array or a "csv-ish" string.
// Accepts commas, spaces, newlines, semicolons. Filters non-finite values.
function parseNumList(input) {
  if (Array.isArray(input)) {
    return input.map(Number).filter(Number.isFinite);
  }
  if (typeof input === 'string') {
    return input
      .split(/[\s,;]+/g)
      .map(s => Number(s.trim()))
      .filter(Number.isFinite);
  }
  return [];
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// Build the LP config expected by lib/build-lp.js from settings (txt → arrays)
// Throws 422 when arrays are missing/empty or lengths mismatch.
export function buildSolverConfigFromSettings(settings) {
  const stepSize_m = Number(settings.stepSize_m) || 15;

  // Prefer already-materialized arrays if present; otherwise parse *_txt.
  const load_W = Array.isArray(settings.load_W) ? settings.load_W.map(Number) : parseNumList(settings.load_W_txt);
  const pv_W = Array.isArray(settings.pv_W) ? settings.pv_W.map(Number) : parseNumList(settings.pv_W_txt);
  const importPrice = Array.isArray(settings.importPrice) ? settings.importPrice.map(Number) : parseNumList(settings.importPrice_txt);
  const exportPrice = Array.isArray(settings.exportPrice) ? settings.exportPrice.map(Number) : parseNumList(settings.exportPrice_txt);

  const T = Math.min(load_W.length, pv_W.length, importPrice.length, exportPrice.length);
  if (!T) {
    throw new HttpError(422, 'Time series are missing or empty', {
      details: { load: load_W.length, pv: pv_W.length, importPrice: importPrice.length, exportPrice: exportPrice.length },
    });
  }
  // Trim to common length T
  const trim = (arr) => arr.slice(0, T);

  const cfg = {
    // arrays
    load_W: trim(load_W),
    pv_W: trim(pv_W),
    importPrice: trim(importPrice),
    exportPrice: trim(exportPrice),

    // scalars (fall back to reasonable defaults already present in defaults.json)
    stepSize_m,
    batteryCapacity_Wh: Number(settings.batteryCapacity_Wh) || 20480,
    minSoc_percent: Number(settings.minSoc_percent) || 20,
    maxSoc_percent: Number(settings.maxSoc_percent) || 100,
    maxChargePower_W: Number(settings.maxChargePower_W) || 3600,
    maxDischargePower_W: Number(settings.maxDischargePower_W) || 4000,
    maxGridImport_W: Number(settings.maxGridImport_W) || 2500,
    maxGridExport_W: Number(settings.maxGridExport_W) || 5000,
    chargeEfficiency_percent: Number(settings.chargeEfficiency_percent) || 95,
    dischargeEfficiency_percent: Number(settings.dischargeEfficiency_percent) || 95,
    batteryCost_cent_per_kWh: Number(settings.batteryCost_cent_per_kWh) || 2,

    terminalSocValuation: settings.terminalSocValuation || 'zero',
    terminalSocCustomPrice_cents_per_kWh: Number(settings.terminalSocCustomPrice_cents_per_kWh) || 0,

    initialSoc_percent: Number(settings.initialSoc_percent) || 20,
  };

  // Basic shape checks that lib/build-lp.js relies on.
  if (cfg.pv_W.length !== T || cfg.importPrice.length !== T || cfg.exportPrice.length !== T) {
    throw new HttpError(422, 'Arrays must have the same length after parsing/trim.');
  }

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
