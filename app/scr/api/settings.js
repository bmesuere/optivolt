import { getJson, putJson } from "./client.js";

export async function fetchStoredSettings() {
  const settings = await getJson("/settings");
  if (settings && typeof settings === "object") {
    return settings;
  }
  return { system: {}, data: {}, algorithm: {}, ui: {} };
}

export function saveStoredSettings(structuredSettings) {
  return putJson("/settings", structuredSettings);
}
