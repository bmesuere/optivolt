import { postJson } from "./client.js";

export async function fetchVrmSettings() {
  const payload = await postJson("/vrm/settings", {});
  if (payload && typeof payload === "object") {
    if (payload.settings && typeof payload.settings === "object") {
      return payload.settings;
    }
    const categories = ["system", "data", "algorithm", "ui"];
    if (categories.some((key) => payload[key] && typeof payload[key] === "object")) {
      return payload;
    }
  }
  return null;
}

export function fetchVrmTimeseries() {
  return postJson("/vrm/timeseries", {});
}
