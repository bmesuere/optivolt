import { fetchStoredSettings, saveStoredSettings } from "./api/settings.js";

const CATEGORY_FIELDS = {
  system: [
    "batteryCapacity_Wh",
    "minSoc_percent",
    "maxSoc_percent",
    "maxChargePower_W",
    "maxDischargePower_W",
    "maxGridImport_W",
    "maxGridExport_W",
    "chargeEfficiency_percent",
    "dischargeEfficiency_percent",
    "batteryCost_cent_per_kWh",
  ],
  data: [
    "initialSoc_percent",
    "stepSize_m",
    "tsStart",
    "load_W_txt",
    "pv_W_txt",
    "importPrice_txt",
    "exportPrice_txt",
  ],
  algorithm: [
    "terminalSocValuation",
    "terminalSocCustomPrice_cents_per_kWh",
  ],
  ui: [
    "tableShowKwh",
    "darkMode",
  ],
};

const CATEGORY_NAMES = Object.keys(CATEGORY_FIELDS);

function createEmptyStructured() {
  return CATEGORY_NAMES.reduce((acc, category) => {
    acc[category] = {};
    return acc;
  }, {});
}

export function flattenStructured(structured) {
  const flat = {};
  for (const category of CATEGORY_NAMES) {
    const values = structured?.[category];
    if (!values || typeof values !== "object") continue;

    for (const key of CATEGORY_FIELDS[category]) {
      if (Object.prototype.hasOwnProperty.call(values, key)) {
        flat[key] = values[key];
      }
    }
  }
  return flat;
}

function splitSnapshot(snapshot) {
  const structured = createEmptyStructured();
  if (!snapshot || typeof snapshot !== "object") {
    return structured;
  }

  for (const category of CATEGORY_NAMES) {
    for (const key of CATEGORY_FIELDS[category]) {
      if (Object.prototype.hasOwnProperty.call(snapshot, key)) {
        structured[category][key] = snapshot[key];
      }
    }
  }

  return structured;
}

export async function loadInitialConfig() {
  try {
    const structured = await fetchStoredSettings();
    const config = flattenStructured(structured);
    return { config, source: "api" };
  } catch (error) {
    console.error("Failed to load settings from API", error);
    return { config: flattenStructured(createEmptyStructured()), source: "error" };
  }
}

export async function saveConfig(snapshot) {
  const structured = splitSnapshot(snapshot);
  await saveStoredSettings(structured);
}
