import { BACKEND_MODE, API_BASE_URL } from "../runtime-config.js";
import { STORAGE_KEY, loadFromStorage, saveToStorage } from "./storage.js";

function normaliseBaseUrl(baseUrl) {
  return (baseUrl || "").replace(/\/$/, "");
}

function buildApiUrl(path) {
  const base = normaliseBaseUrl(API_BASE_URL);
  return `${base}${path}`;
}

export async function loadInitialConfig(defaults) {
  if (BACKEND_MODE === "api") {
    try {
      const res = await fetch(buildApiUrl("/settings"));
      if (!res.ok) {
        throw new Error(`Settings request failed with ${res.status}`);
      }
      const data = await res.json();
      return { config: { ...defaults, ...data }, source: "api" };
    } catch (error) {
      console.error("Failed to load settings from API", error);
      return { config: { ...defaults }, source: "defaults" };
    }
  }

  const stored = loadFromStorage(STORAGE_KEY);
  if (stored) {
    return { config: { ...defaults, ...stored }, source: "storage" };
  }
  return { config: { ...defaults }, source: "defaults" };
}

export async function saveConfig(config) {
  if (BACKEND_MODE === "api") {
    const res = await fetch(buildApiUrl("/settings"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `Settings request failed with ${res.status}`);
    }
    return;
  }

  saveToStorage(STORAGE_KEY, config);
}
