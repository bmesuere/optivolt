import { fetchStoredSettings, saveStoredSettings } from "./api/settings.js";

// Load exactly what the API has; do not merge client defaults anymore.
export async function loadInitialConfig() {
  try {
    const data = await fetchStoredSettings();
    // If /settings doesn’t exist yet, handler returns server defaults.
    // Otherwise, it’s the user’s persisted snapshot.
    return { config: data || {}, source: "api" };
  } catch (error) {
    console.error("Failed to load settings from API", error);
    // Stay minimal: return empty config; inputs keep their HTML values/placeholders.
    return { config: {}, source: "api-error" };
  }
}

export async function saveConfig(config) {
  await saveStoredSettings(config);
}
