import { VRMClient } from '../../lib/vrm-api.js';
import { loadSettings, saveSettings } from './settings-store.js';
import { loadData, saveData } from './data-store.js';
import { readVictronSocPercent, readVictronSocLimits } from './mqtt-service.js';

function createClientFromEnv() {
  const installationId = (process.env.VRM_INSTALLATION_ID ?? '').trim();
  const token = (process.env.VRM_TOKEN ?? '').trim();
  if (!installationId) throw new Error('VRM Site ID not configured');
  if (!token) throw new Error('VRM API token not configured');
  return new VRMClient({ installationId, token });
}

/** Persist relatively static system settings from VRM (no timeseries). */
export async function refreshSettingsFromVrmAndPersist() {
  const client = createClientFromEnv();

  const [vrmSettings, socLimits] = await Promise.all([
    client.fetchDynamicEssSettings(),
    // Prefer MQTT for SoC limits; fall back gracefully if it fails.
    readVictronSocLimits({ timeoutMs: 5000 }).catch((err) => {
      console.error('Failed to read SoC limits from MQTT:', err?.message ?? String(err));
      return null;
    }),
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

    // SoC limits now come from MQTT (if available), otherwise keep existing.
    minSoc_percent:
      (socLimits?.minSoc_percent ?? base.minSoc_percent),
    maxSoc_percent:
      (socLimits?.maxSoc_percent ?? base.maxSoc_percent),
  };

  await saveSettings(merged);
  return merged;
}

/**
 * Fetch VRM series (load + PV + prices) and persist RAW data.
 * No slicing/alignment is done here; the "Smart Reader" handles that.
 */
export async function refreshSeriesFromVrmAndPersist() {
  const client = createClientFromEnv();

  const settings = await loadSettings();
  const sources = settings.dataSources || {};

  const shouldFetchForecasts = sources.load === 'vrm' || sources.pv === 'vrm';
  const shouldFetchPrices = sources.prices === 'vrm';
  const shouldFetchSoc = sources.soc === 'mqtt';

  // Concurrent IO
  const [forecastsResult, pricesResult, socResult] = await Promise.allSettled([
    shouldFetchForecasts ? client.fetchForecasts() : Promise.resolve(null),
    shouldFetchPrices ? client.fetchPrices() : Promise.resolve(null),
    shouldFetchSoc ? readVictronSocPercent({ timeoutMs: 5000 }) : Promise.resolve(null),
  ]);

  let forecasts = null;
  if (shouldFetchForecasts) {
    if (forecastsResult.status === 'fulfilled') forecasts = forecastsResult.value;
    else console.error('Failed to fetch forecasts:', forecastsResult.reason?.message ?? String(forecastsResult.reason));
  }

  let prices = null;
  if (shouldFetchPrices) {
    if (pricesResult.status === 'fulfilled') prices = pricesResult.value;
    else console.error('Failed to fetch prices:', pricesResult.reason?.message ?? String(pricesResult.reason));
  }

  let socPercent = null;
  if (shouldFetchSoc) {
    if (socResult.status === 'fulfilled') socPercent = socResult.value;
    else console.error('Failed to read SoC from MQTT:', socResult.reason?.message ?? String(socResult.reason));
  }

  // Load previous data for fallback (we overwrite specific keys if VRM usage is active)
  const baseData = await loadData();
  const baseSettings = settings;

  // Helper to extract start time safely
  const getStart = (obj, label) => {
    if (obj?.timestamps?.length > 0) {
      return new Date(obj.timestamps[0]).toISOString();
    }
    throw new Error(`VRM returned no timestamps for ${label}.`);
  };

  // Build new data structures (or keep existing)

  let load = baseData.load;
  // If we fetched forecasts AND the user wants VRM load, use it
  if (shouldFetchForecasts && sources.load !== 'api' && forecasts) {
    load = {
      start: getStart(forecasts, 'load'),
      step: forecasts?.step_minutes ?? 15,
      values: forecasts?.load_W ?? []
    };
  }

  let pv = baseData.pv;
  if (shouldFetchForecasts && sources.pv !== 'api' && forecasts) {
    pv = {
      start: getStart(forecasts, 'pv'),
      step: forecasts?.step_minutes ?? 15,
      values: forecasts?.pv_W ?? []
    };
  }

  let importPrice = baseData.importPrice;
  let exportPrice = baseData.exportPrice;
  if (shouldFetchPrices && prices) {
    importPrice = {
      start: getStart(prices, 'importPrice'),
      step: prices?.step_minutes ?? 15,
      values: prices?.importPrice_cents_per_kwh ?? []
    };
    exportPrice = {
      start: getStart(prices, 'exportPrice'),
      step: prices?.step_minutes ?? 15,
      values: prices?.exportPrice_cents_per_kwh ?? []
    };
  }

  const soc = {
    timestamp: (shouldFetchSoc && Number.isFinite(socPercent))
      ? new Date().toISOString()
      : (baseData.soc?.timestamp ?? new Date().toISOString()),
    value: (shouldFetchSoc && Number.isFinite(socPercent))
      ? socPercent
      : (baseData.soc?.value ?? baseData.initialSoc_percent ?? baseSettings.initialSoc_percent)
  };

  // Build new data snapshot
  const nextData = {
    ...baseData,

    // New structure
    load,
    pv,
    importPrice,
    exportPrice,
    soc,

    // Deprecated fields
    tsStart: undefined,
    load_W: undefined,
    pv_W: undefined,
    prices: undefined, // Clear the intermediate 'prices' object if it existed from previous dev iteration
    initialSoc_percent: undefined
  };

  await saveData(nextData);

  // Optionally keep stepSize_m in settings in sync
  const nextSettings = {
    ...baseSettings,
    stepSize_m: forecasts?.step_minutes || baseSettings.stepSize_m || 15,
  };
  await saveSettings(nextSettings);
}
