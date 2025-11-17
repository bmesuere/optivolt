import { VRMClient } from '../../lib/vrm-api.js';
import { loadSettings, saveSettings } from './settings-store.js';
import { loadData, saveData } from './data-store.js';
import { readVictronSocPercent } from './mqtt-service.js';

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
  const [vrmSettings, vrmMinSoc] = await Promise.all([
    client.fetchDynamicEssSettings(),
    client.fetchMinSocLimit()
  ]);
  const base = await loadSettings();

  const merged = {
    ...base,
    batteryCapacity_Wh:
      vrmSettings?.batteryCapacity_Wh ?? base.batteryCapacity_Wh,
    maxDischargePower_W:
      vrmSettings?.dischargePower_W ??
      vrmSettings?.limits?.batteryDischargeLimit_W ??
      base.maxDischargePower_W,
    maxChargePower_W:
      vrmSettings?.chargePower_W ??
      vrmSettings?.limits?.batteryChargeLimit_W ??
      base.maxChargePower_W,
    maxGridImport_W:
      vrmSettings?.maxPowerFromGrid_W ??
      vrmSettings?.limits?.gridImportLimit_W ??
      base.maxGridImport_W,
    maxGridExport_W:
      vrmSettings?.maxPowerToGrid_W ??
      vrmSettings?.limits?.gridExportLimit_W ??
      base.maxGridExport_W,
    batteryCost_cent_per_kWh:
      vrmSettings?.batteryCosts_cents_per_kWh ?? base.batteryCost_cent_per_kWh,
    minSoc_percent:
      vrmMinSoc?.minSoc_pct ?? base.minSoc_percent,
  };

  await saveSettings(merged);
  return merged;
}

/**
 * Fetch VRM series (load + PV + prices), align to last quarter,
 * and persist only series + tsStart/step + SoC (data layer).
 *
 * SoC comes from MQTT instead of the VRM API.
 */
export async function refreshSeriesFromVrmAndPersist() {
  const client = createClientFromEnv();

  // --- fetch VRM series + MQTT SoC in parallel ---
  const [forecasts, prices, socPercent] = await Promise.all([
    client.fetchForecasts(),
    client.fetchPrices(),
    readVictronSocPercent({ timeoutMs: 5000 }).catch((err) => {
      console.error('Failed to read SoC from MQTT:', err?.message ?? String(err));
      return null;
    }),
  ]);

  // --- quarter alignment (unchanged logic) ---
  const quarterStartMs = lastQuarterMs(new Date());
  const stepMin = Number(forecasts?.step_minutes ?? 15);

  const fullHourStartMs =
    Array.isArray(forecasts?.timestamps) && forecasts.timestamps.length > 0
      ? Number(forecasts.timestamps[0])
      : (() => {
        const d = new Date();
        d.setMinutes(0, 0, 0);
        return d.getTime();
      })();

  let offsetSlots = Math.floor(
    (quarterStartMs - fullHourStartMs) / (stepMin * 60 * 1000),
  );
  if (!Number.isFinite(offsetSlots) || offsetSlots < 0) offsetSlots = 0;
  if (stepMin === 15) offsetSlots = Math.min(offsetSlots, 3);

  const slice = (arr) => (Array.isArray(arr) ? arr.slice(offsetSlots) : []);

  // Load previous settings/data for fallback
  const [baseSettings, baseData] = await Promise.all([loadSettings(), loadData()]);

  const load_W = slice(forecasts?.load_W);
  const pv_W = slice(forecasts?.pv_W);
  const importPrice = slice(prices?.importPrice_cents_per_kwh);
  const exportPrice = slice(prices?.exportPrice_cents_per_kwh);

  // Build new data snapshot
  const nextData = {
    ...baseData,
    tsStart: toLocalDatetimeLocal(new Date(quarterStartMs)),

    // Time series as arrays (data layer)
    load_W: load_W.length ? load_W : baseData.load_W || [],
    pv_W: pv_W.length ? pv_W : baseData.pv_W || [],
    importPrice: importPrice.length ? importPrice : baseData.importPrice || [],
    exportPrice: exportPrice.length ? exportPrice : baseData.exportPrice || [],

    // Current SoC now comes from MQTT
    initialSoc_percent: Number.isFinite(socPercent)
      ? socPercent
      : (baseData.initialSoc_percent ?? baseSettings.initialSoc_percent),
  };

  await saveData(nextData);

  // Optionally keep stepSize_m in settings in sync with VRM step
  const nextSettings = {
    ...baseSettings,
    stepSize_m: stepMin || baseSettings.stepSize_m || 15,
  };
  await saveSettings(nextSettings);
}
