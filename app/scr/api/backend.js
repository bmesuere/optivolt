import { postJson } from "./client.js";

export async function fetchVrmSettings() {
  const payload = await postJson("/vrm/settings", {});
  if (payload && typeof payload === "object" && payload.settings && typeof payload.settings === "object") {
    return payload.settings;
  }
  return {};
}

export function fetchVrmTimeseries() {
  return postJson("/vrm/timeseries", {});
}
