import { postJson } from "./client.js";

// Server-side actions (clean)
export function refreshVrmSettings() {
  return postJson("/vrm/refresh-settings", {});
}
export function refreshVrmSeries() {
  return postJson("/vrm/refresh-series", {});
}
