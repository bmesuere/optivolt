import { postJson } from "./client.js";

// Server-side actions
export function refreshVrmSettings() {
  return postJson("/vrm/refresh-settings", {});
}
