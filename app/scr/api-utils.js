import { API_BASE_URL } from "../runtime-config.js";

export function normaliseBaseUrl(baseUrl) {
  return (baseUrl || "").replace(/\/$/, "");
}

export function buildApiUrl(path, baseUrl = API_BASE_URL) {
  return `${normaliseBaseUrl(baseUrl)}${path}`;
}
