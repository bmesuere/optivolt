import { getJson, postJson } from "./client.js";

const SYSTEM_KEYS = [
  "stepSize_m",
  "batteryCapacity_Wh",
  "minSoc_percent",
  "maxSoc_percent",
  "initialSoc_percent",
  "maxChargePower_W",
  "maxDischargePower_W",
  "maxGridImport_W",
  "maxGridExport_W",
  "chargeEfficiency_percent",
  "dischargeEfficiency_percent",
  "batteryCost_cent_per_kWh",
];

const ALGORITHM_KEYS = [
  "terminalSocValuation",
  "terminalSocCustomPrice_cents_per_kWh",
];

const TIMESERIES_KEYS = [
  "load_W_txt",
  "pv_W_txt",
  "importPrice_txt",
  "exportPrice_txt",
  "tsStart",
  "tableShowKwh",
];

function pick(source, keys) {
  const out = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      out[key] = source[key];
    }
  }
  return out;
}

export async function fetchStoredSettings() {
  const [system, algorithm, timeseries] = await Promise.all([
    getJson("/settings/system"),
    getJson("/settings/algorithm"),
    getJson("/settings/time-series"),
  ]);

  return { ...system, ...algorithm, ...timeseries };
}

export async function saveStoredSettings(config) {
  const system = pick(config, SYSTEM_KEYS);
  const algorithm = pick(config, ALGORITHM_KEYS);
  const timeseries = pick(config, TIMESERIES_KEYS);

  await Promise.all([
    postJson("/settings/system", system),
    postJson("/settings/algorithm", algorithm),
    postJson("/settings/time-series", timeseries),
  ]);
}
