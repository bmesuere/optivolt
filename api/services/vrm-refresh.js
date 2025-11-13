import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VRMClient } from '../../lib/vrm-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.resolve(__dirname, '../../data'));
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const DEFAULT_PATH = path.resolve(__dirname, '../../lib/default-settings.json');

async function readJson(filePath) {
  const txt = await fs.readFile(filePath, 'utf8');
  return JSON.parse(txt);
}
async function readSettingsOrDefaults() {
  try { return await readJson(SETTINGS_PATH); }
  catch (err) { if (err?.code !== 'ENOENT') throw err; return readJson(DEFAULT_PATH); }
}
async function writeSettings(settings) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}
function createClientFromEnv() {
  const installationId = (process.env.VRM_INSTALLATION_ID ?? '').trim();
  const token = (process.env.VRM_TOKEN ?? '').trim();
  if (!installationId) throw new Error('VRM Site ID not configured');
  if (!token) throw new Error('VRM API token not configured');
  return new VRMClient({ installationId, token });
}

/** Last local quarter (00/15/30/45) in ms since epoch. */
function lastQuarterMs(baseDate = new Date()) {
  const d = new Date(baseDate);
  const q = Math.floor(d.getMinutes() / 15) * 15;
  d.setMinutes(q, 0, 0);
  return d.getTime();
}

/** Format Date -> "YYYY-MM-DDTHH:MM" for <input type="datetime-local"> */
function toLocalDatetimeLocal(dt) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

/** Persist relatively static system settings from VRM (no timeseries). */
export async function refreshSettingsFromVrmAndPersist() {
  const client = createClientFromEnv();
  const vrmSettings = await client.fetchDynamicEssSettings();
  const base = await readSettingsOrDefaults();

  const merged = {
    ...base,
    batteryCapacity_Wh: vrmSettings?.batteryCapacity_Wh ?? base.batteryCapacity_Wh,
    maxDischargePower_W: vrmSettings?.dischargePower_W ?? vrmSettings?.limits?.batteryDischargeLimit_W ?? base.maxDischargePower_W,
    maxChargePower_W: vrmSettings?.chargePower_W ?? vrmSettings?.limits?.batteryChargeLimit_W ?? base.maxChargePower_W,
    maxGridImport_W: vrmSettings?.maxPowerFromGrid_W ?? vrmSettings?.limits?.gridImportLimit_W ?? base.maxGridImport_W,
    maxGridExport_W: vrmSettings?.maxPowerToGrid_W ?? vrmSettings?.limits?.gridExportLimit_W ?? base.maxGridExport_W,
    batteryCost_cent_per_kWh: vrmSettings?.batteryCosts_cents_per_kWh ?? base.batteryCost_cent_per_kWh,
  };

  await writeSettings(merged);
  return merged;
}

/** Fetch VRM series, align to last quarter, and PERSIST only series + tsStart/step + SoC. */
export async function refreshSeriesFromVrmAndPersist() {
  const client = createClientFromEnv();
  const [forecasts, prices, soc] = await Promise.all([
    client.fetchForecasts(), // { step_minutes, timestamps, load_W, pv_W, ... }
    client.fetchPrices(),    // { importPrice_cents_per_kwh, exportPrice_cents_per_kwh, ... }
    client.fetchCurrentSoc() // { soc_percent, timestampMs }
  ]);

  // --- quarter alignment lives here now ---
  const quarterStartMs = lastQuarterMs(new Date());
  const stepMin = Number(forecasts?.step_minutes ?? 15);

  const fullHourStartMs = Array.isArray(forecasts?.timestamps) && forecasts.timestamps.length > 0
    ? Number(forecasts.timestamps[0])
    : (() => { const d = new Date(); d.setMinutes(0, 0, 0); return d.getTime(); })();

  let offsetSlots = Math.floor((quarterStartMs - fullHourStartMs) / (stepMin * 60 * 1000));
  if (!Number.isFinite(offsetSlots) || offsetSlots < 0) offsetSlots = 0;
  if (stepMin === 15) offsetSlots = Math.min(offsetSlots, 3);

  const slice = (arr) => (Array.isArray(arr) ? arr.slice(offsetSlots) : []);
  const join = (arr) => (Array.isArray(arr) ? arr.join(',') : '');

  const base = await readSettingsOrDefaults();

  const merged = {
    ...base,
    stepSize_m: stepMin || 15,
    tsStart: toLocalDatetimeLocal(new Date(quarterStartMs)),

    load_W_txt: join(slice(forecasts?.load_W)) || base.load_W_txt || '',
    pv_W_txt: join(slice(forecasts?.pv_W)) || base.pv_W_txt || '',
    importPrice_txt: join(slice(prices?.importPrice_cents_per_kwh)) || base.importPrice_txt || '',
    exportPrice_txt: join(slice(prices?.exportPrice_cents_per_kwh)) || base.exportPrice_txt || '',

    initialSoc_percent: Number.isFinite(soc?.soc_percent) ? soc.soc_percent : base.initialSoc_percent,
  };

  await writeSettings(merged);
  return merged;
}
