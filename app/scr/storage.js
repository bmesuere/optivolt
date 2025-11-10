export const STORAGE_KEY = "optivolt-config-v1";
export const STORAGE_VRM_KEY = "optivolt-vrm-cred-v1";
export const SYSTEM_FETCHED_KEY = "optivolt-system-settings-fetched-at";

export function saveToStorage(key, obj) {
  try { localStorage.setItem(key, JSON.stringify(obj)); } catch { /* ignore */ }
}
export function loadFromStorage(key) {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : null; } catch { return null; }
}
export function removeFromStorage(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}
export function isSystemSettingsFetched() {
  try { return !!localStorage.getItem(SYSTEM_FETCHED_KEY); } catch { return false; }
}
export function setSystemFetched(v = true) {
  try { v ? localStorage.setItem(SYSTEM_FETCHED_KEY, "1") : localStorage.removeItem(SYSTEM_FETCHED_KEY); } catch { }
}
