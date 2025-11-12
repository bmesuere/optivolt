import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertCondition } from '../http-errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.resolve(__dirname, '../../data'));

const PATHS = {
  system: path.join(DATA_DIR, 'system-settings.json'),
  algorithm: path.join(DATA_DIR, 'algorithm-settings.json'),
  timeseries: path.join(DATA_DIR, 'time-series.json'),
};

const DEFAULT_PATHS = {
  system: path.resolve(__dirname, '../../lib/default-system-settings.json'),
  algorithm: path.resolve(__dirname, '../../lib/default-algorithm-settings.json'),
  timeseries: path.resolve(__dirname, '../../lib/default-time-series.json'),
};

const LEGACY_SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

const defaultCache = new Map();
let legacySettingsCache = null;
let legacySettingsLoaded = false;

function clone(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

async function readJson(filePath) {
  const data = await fs.readFile(filePath, 'utf8');
  return JSON.parse(data);
}

async function readLegacySettings() {
  if (legacySettingsLoaded) {
    return legacySettingsCache;
  }

  try {
    const legacy = await readJson(LEGACY_SETTINGS_PATH);
    legacySettingsCache = legacy && typeof legacy === 'object' ? legacy : null;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      legacySettingsCache = null;
    } else {
      throw error;
    }
  }

  legacySettingsLoaded = true;
  return legacySettingsCache;
}

async function getDefaults(key) {
  if (!defaultCache.has(key)) {
    const defaults = await readJson(DEFAULT_PATHS[key]);
    defaultCache.set(key, defaults);
  }
  // Return a defensive copy to avoid accidental mutation
  return clone(defaultCache.get(key));
}

async function readWithDefault(key, fields, formatter = (value) => value) {
  const defaults = await getDefaults(key);
  try {
    const stored = await readJson(PATHS[key]);
    const sanitized = pickKnownFields(stored, fields, formatter);
    return { ...defaults, ...sanitized };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const legacy = await readLegacySettings();
      const legacySanitized = pickKnownFields(legacy, fields, formatter);
      if (Object.keys(legacySanitized).length > 0) {
        return { ...defaults, ...legacySanitized };
      }
      return defaults;
    }
    throw error;
  }
}

async function writeJson(key, value) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(PATHS[key], payload, 'utf8');
}

function ensurePlainObject(value, message) {
  assertCondition(value && typeof value === 'object' && !Array.isArray(value), 400, message);
}

const SYSTEM_FIELDS = [
  'stepSize_m',
  'batteryCapacity_Wh',
  'minSoc_percent',
  'maxSoc_percent',
  'initialSoc_percent',
  'maxChargePower_W',
  'maxDischargePower_W',
  'maxGridImport_W',
  'maxGridExport_W',
  'chargeEfficiency_percent',
  'dischargeEfficiency_percent',
  'batteryCost_cent_per_kWh',
];

const ALGORITHM_FIELDS = [
  'terminalSocValuation',
  'terminalSocCustomPrice_cents_per_kWh',
];

const TIMESERIES_FIELDS = [
  'load_W_txt',
  'pv_W_txt',
  'importPrice_txt',
  'exportPrice_txt',
  'tsStart',
  'tableShowKwh',
];

const TIME_SERIES_FORMATTER = (value, key) => {
  if (key === 'tableShowKwh') {
    return Boolean(value);
  }
  return value == null ? '' : String(value);
};

function pickKnownFields(source, allowed, formatter = (x) => x) {
  const out = {};
  if (!source || typeof source !== 'object') {
    return out;
  }
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      out[key] = formatter(source[key], key);
    }
  }
  return out;
}

export async function getSystemSettings() {
  return readWithDefault('system', SYSTEM_FIELDS);
}

export async function getAlgorithmSettings() {
  return readWithDefault('algorithm', ALGORITHM_FIELDS);
}

export async function getTimeSeriesSettings() {
  return readWithDefault('timeseries', TIMESERIES_FIELDS, TIME_SERIES_FORMATTER);
}

export async function saveSystemSettings(settings) {
  ensurePlainObject(settings, 'system settings payload must be an object');
  const sanitized = pickKnownFields(settings, SYSTEM_FIELDS);
  await writeJson('system', sanitized);
}

export async function saveAlgorithmSettings(settings) {
  ensurePlainObject(settings, 'algorithm settings payload must be an object');
  const sanitized = pickKnownFields(settings, ALGORITHM_FIELDS);
  await writeJson('algorithm', sanitized);
}

export async function saveTimeSeriesSettings(settings) {
  ensurePlainObject(settings, 'time series payload must be an object');
  const sanitized = pickKnownFields(settings, TIMESERIES_FIELDS, TIME_SERIES_FORMATTER);
  await writeJson('timeseries', sanitized);
}

function parseSeries(text) {
  return String(text ?? '')
    .split(/[\s,]+/)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
}

function toNumberWithFallback(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export async function loadSolverInputs() {
  const [system, algorithm, timeseries] = await Promise.all([
    getSystemSettings(),
    getAlgorithmSettings(),
    getTimeSeriesSettings(),
  ]);

  const defaults = await getDefaults('system');
  const algorithmDefaults = await getDefaults('algorithm');

  const load_W = parseSeries(timeseries.load_W_txt);
  const pv_W = parseSeries(timeseries.pv_W_txt);
  const importPrice = parseSeries(timeseries.importPrice_txt);
  const exportPrice = parseSeries(timeseries.exportPrice_txt);

  const T = Math.min(load_W.length, pv_W.length, importPrice.length, exportPrice.length);
  assertCondition(T > 0, 400, 'No time series data available for calculation.');

  const clip = (arr) => arr.slice(0, T);

  const numericFields = {
    stepSize_m: defaults.stepSize_m,
    batteryCapacity_Wh: defaults.batteryCapacity_Wh,
    minSoc_percent: defaults.minSoc_percent,
    maxSoc_percent: defaults.maxSoc_percent,
    initialSoc_percent: defaults.initialSoc_percent,
    maxChargePower_W: defaults.maxChargePower_W,
    maxDischargePower_W: defaults.maxDischargePower_W,
    maxGridImport_W: defaults.maxGridImport_W,
    maxGridExport_W: defaults.maxGridExport_W,
    chargeEfficiency_percent: defaults.chargeEfficiency_percent,
    dischargeEfficiency_percent: defaults.dischargeEfficiency_percent,
    batteryCost_cent_per_kWh: defaults.batteryCost_cent_per_kWh,
    terminalSocCustomPrice_cents_per_kWh: algorithmDefaults.terminalSocCustomPrice_cents_per_kWh,
  };

  const cfg = {
    ...defaults,
    ...system,
    ...algorithmDefaults,
    ...algorithm,
    load_W: clip(load_W),
    pv_W: clip(pv_W),
    importPrice: clip(importPrice),
    exportPrice: clip(exportPrice),
  };

  for (const [key, fallback] of Object.entries(numericFields)) {
    cfg[key] = toNumberWithFallback(cfg[key], fallback);
  }

  cfg.terminalSocValuation = String(cfg.terminalSocValuation ?? algorithmDefaults.terminalSocValuation);

  return { config: cfg, timeseries: { ...timeseries } };
}
