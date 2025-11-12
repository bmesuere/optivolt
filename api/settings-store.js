import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HttpError } from './http-errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.resolve(__dirname, '../data'));
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const DEFAULT_PATH = path.resolve(__dirname, '../lib/default-settings.json');

const CATEGORY_KEYS = {
  system: [
    'batteryCapacity_Wh',
    'minSoc_percent',
    'maxSoc_percent',
    'maxChargePower_W',
    'maxDischargePower_W',
    'maxGridImport_W',
    'maxGridExport_W',
    'chargeEfficiency_percent',
    'dischargeEfficiency_percent',
    'batteryCost_cent_per_kWh',
  ],
  data: [
    'initialSoc_percent',
    'stepSize_m',
    'tsStart',
    'load_W_txt',
    'pv_W_txt',
    'importPrice_txt',
    'exportPrice_txt',
  ],
  algorithm: [
    'terminalSocValuation',
    'terminalSocCustomPrice_cents_per_kWh',
  ],
  ui: [
    'tableShowKwh',
    'darkMode',
  ],
};

export const CATEGORY_NAMES = Object.keys(CATEGORY_KEYS);
const FIELD_TO_CATEGORY = new Map(
  CATEGORY_NAMES.flatMap((category) => CATEGORY_KEYS[category].map((field) => [field, category])),
);

let defaultCache;

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createEmptyStructured() {
  return CATEGORY_NAMES.reduce((acc, category) => {
    acc[category] = {};
    return acc;
  }, {});
}

async function loadDefaultStructured() {
  if (!defaultCache) {
    const flatDefaults = await readJson(DEFAULT_PATH);
    defaultCache = splitFlatToStructured(flatDefaults);
  }
  return clone(defaultCache);
}

function isStructuredSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return CATEGORY_NAMES.some((name) => name in value);
}

function sanitiseCategoryObject(category, value) {
  const allowed = new Set(CATEGORY_KEYS[category]);
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return result;
  }

  for (const key of Object.keys(value)) {
    if (allowed.has(key)) {
      result[key] = value[key];
    }
  }
  return result;
}

function sanitiseStructuredInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return createEmptyStructured();
  }

  const result = createEmptyStructured();
  for (const category of CATEGORY_NAMES) {
    if (category in value) {
      result[category] = sanitiseCategoryObject(category, value[category]);
    }
  }
  return result;
}

function splitFlatToStructured(flat) {
  const result = createEmptyStructured();
  if (!flat || typeof flat !== 'object' || Array.isArray(flat)) {
    return result;
  }

  for (const [key, value] of Object.entries(flat)) {
    const category = FIELD_TO_CATEGORY.get(key);
    if (category) {
      result[category][key] = value;
    }
  }

  return result;
}

function mergeStructured(base, patch) {
  const merged = createEmptyStructured();
  for (const category of CATEGORY_NAMES) {
    merged[category] = {
      ...base[category],
      ...patch[category],
    };
  }
  return merged;
}

async function writeStructured(structured) {
  const defaults = await loadDefaultStructured();
  const sanitised = sanitiseStructuredInput(structured);
  const merged = mergeStructured(defaults, sanitised);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_PATH, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return merged;
}

function normaliseInput(raw) {
  if (isStructuredSettings(raw)) {
    return sanitiseStructuredInput(raw);
  }
  return sanitiseStructuredInput(splitFlatToStructured(raw));
}

export async function loadSettings() {
  const defaults = await loadDefaultStructured();

  try {
    const raw = await readJson(SETTINGS_PATH);
    const structured = normaliseInput(raw);
    return mergeStructured(defaults, structured);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return clone(defaults);
    }
    throw error;
  }
}

export async function loadSettingsCategory(category) {
  assertCategory(category);
  const settings = await loadSettings();
  return clone(settings[category]);
}

export async function replaceSettings(payload) {
  const structured = normaliseInput(payload);
  return writeStructured(structured);
}

export async function updateSettings(partial) {
  const current = await loadSettings();
  const patch = normaliseInput(partial);
  const merged = mergeStructured(current, patch);
  return writeStructured(merged);
}

export async function updateSettingsCategory(category, values) {
  assertCategory(category);
  const current = await loadSettings();
  const patch = sanitiseCategoryObject(category, values);
  const merged = {
    ...current,
    [category]: {
      ...current[category],
      ...patch,
    },
  };
  await writeStructured(merged);
  return merged[category];
}

export function structuredToFlat(settings) {
  const flat = {};
  for (const category of CATEGORY_NAMES) {
    Object.assign(flat, settings[category]);
  }
  return flat;
}

export function structuredToSolverConfig(settings) {
  const flat = structuredToFlat(settings);
  const defaults = defaultCache ? structuredToFlat(defaultCache) : flat;

  const load_W = parseSeries(flat.load_W_txt ?? defaults.load_W_txt);
  const pv_W = parseSeries(flat.pv_W_txt ?? defaults.pv_W_txt);
  const importPrice = parseSeries(flat.importPrice_txt ?? defaults.importPrice_txt);
  const exportPrice = parseSeries(flat.exportPrice_txt ?? defaults.exportPrice_txt);

  const T = Math.min(load_W.length, pv_W.length, importPrice.length, exportPrice.length);
  if (!Number.isFinite(T) || T <= 0) {
    throw new HttpError(400, 'Stored data is incomplete. Add time series data before running the solver.');
  }

  const clip = (arr) => arr.slice(0, T);

  return {
    load_W: clip(load_W),
    pv_W: clip(pv_W),
    importPrice: clip(importPrice),
    exportPrice: clip(exportPrice),

    stepSize_m: toNumber(flat.stepSize_m, defaults.stepSize_m),
    batteryCapacity_Wh: toNumber(flat.batteryCapacity_Wh, defaults.batteryCapacity_Wh),
    minSoc_percent: toNumber(flat.minSoc_percent, defaults.minSoc_percent),
    maxSoc_percent: toNumber(flat.maxSoc_percent, defaults.maxSoc_percent),
    initialSoc_percent: toNumber(flat.initialSoc_percent, defaults.initialSoc_percent),

    maxChargePower_W: toNumber(flat.maxChargePower_W, defaults.maxChargePower_W),
    maxDischargePower_W: toNumber(flat.maxDischargePower_W, defaults.maxDischargePower_W),
    maxGridImport_W: toNumber(flat.maxGridImport_W, defaults.maxGridImport_W),
    maxGridExport_W: toNumber(flat.maxGridExport_W, defaults.maxGridExport_W),
    chargeEfficiency_percent: toNumber(flat.chargeEfficiency_percent, defaults.chargeEfficiency_percent),
    dischargeEfficiency_percent: toNumber(flat.dischargeEfficiency_percent, defaults.dischargeEfficiency_percent),
    batteryCost_cent_per_kWh: toNumber(flat.batteryCost_cent_per_kWh, defaults.batteryCost_cent_per_kWh),

    terminalSocValuation: typeof flat.terminalSocValuation === 'string'
      ? flat.terminalSocValuation
      : defaults.terminalSocValuation,
    terminalSocCustomPrice_cents_per_kWh: toNumber(
      flat.terminalSocCustomPrice_cents_per_kWh,
      defaults.terminalSocCustomPrice_cents_per_kWh,
    ),
  };
}

function toNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : Number(fallback);
}

function parseSeries(input) {
  if (Array.isArray(input)) {
    return input.map((value) => Number(value)).filter(Number.isFinite);
  }
  const text = typeof input === 'string' ? input : '';
  return text
    .split(/[\s,]+/)
    .map((value) => Number(value))
    .filter(Number.isFinite);
}

function assertCategory(category) {
  if (!CATEGORY_KEYS[category]) {
    throw new HttpError(404, 'Unknown settings category');
  }
}
