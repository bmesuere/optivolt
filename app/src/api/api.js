import { getJson, postJson } from "./client.js";

// --- Settings ---
export async function fetchStoredSettings() {
  const settings = await getJson("/settings");
  if (settings && typeof settings === "object") {
    return settings;
  }
  return {};
}

export function saveStoredSettings(config) {
  return postJson("/settings", config);
}

// --- Solver ---
export function requestRemoteSolve(body = {}) {
  return postJson("/calculate", body);
}

// --- Data ---
export function fetchStoredData() {
  return getJson("/data");
}

// --- VRM ---
export function refreshVrmSettings() {
  return postJson("/vrm/refresh-settings", {});
}

// --- Home Assistant ---
export function fetchHaEntityState(entityId) {
  return getJson(`/ha/entity/${encodeURIComponent(entityId)}`);
}

// --- EV ---
export const fetchEvSchedule = () => getJson('/ev/schedule');
export const fetchEvCurrent = () => getJson('/ev/current');

// --- Predictions ---
export const fetchPredictionConfig = () => getJson('/predictions/config');
export const savePredictionConfig = (c) => postJson('/predictions/config', c);
export const runValidation = () => postJson('/predictions/validate', {});
export const runLoadForecast = () => postJson('/predictions/load/forecast', {});
export const runPvForecast = () => postJson('/predictions/pv/forecast', {});
export const runCombinedForecast = () => postJson('/predictions/forecast', {});
export const fetchForecast = runCombinedForecast;
export const fetchPredictionAdjustments = () => getJson('/predictions/adjustments');
export const createPredictionAdjustment = (adjustment) => postJson('/predictions/adjustments', adjustment);
export const updatePredictionAdjustment = (id, adjustment) => postJson(`/predictions/adjustments/${encodeURIComponent(id)}`, adjustment, { method: 'PATCH' });
export const deletePredictionAdjustment = (id) => postJson(`/predictions/adjustments/${encodeURIComponent(id)}`, {}, { method: 'DELETE' });
