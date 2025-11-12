import { fetchStoredSettings, saveStoredSettings } from "./api/settings.js";

export async function loadInitialConfig(defaults) {
  try {
    const data = await fetchStoredSettings();
    return { config: { ...defaults, ...data }, source: "api" };
  } catch (error) {
    console.error("Failed to load settings from API", error);
    return { config: { ...defaults }, source: "defaults" };
  }
}

export async function saveConfig(config) {
  await saveStoredSettings(config);
}
