// app/vrm.js
import { VRMClient } from "../lib/vrm-api.js";
import { API_BASE_URL, BACKEND_MODE } from "../runtime-config.js";
import { STORAGE_VRM_KEY, saveToStorage, loadFromStorage, removeFromStorage } from "./storage.js";
import { normaliseBaseUrl } from "./api-utils.js";

const isApiMode = BACKEND_MODE === "api";

async function postJson(path, payload) {
  if (!isApiMode) {
    throw new Error("VRM server endpoints are only available in API mode");
  }

  const res = await fetch(`${normaliseBaseUrl(API_BASE_URL)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    let message = `VRM request failed with ${res.status}`;
    try {
      const text = await res.text();
      if (text) {
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed.error === "string") {
            message = parsed.error;
          } else if (parsed && typeof parsed.message === "string") {
            message = parsed.message;
          } else {
            message = text;
          }
        } catch {
          message = text;
        }
      }
    } catch {
      // ignore parsing failures
    }
    throw new Error(message);
  }

  return res.json();
}

export class VRMManager {
  /**
   * @param {object} opts
   * @param {string} [opts.defaultProxyBase]
   */
  constructor({ defaultProxyBase = "https://vrm-cors-proxy.mesuerebart.workers.dev" } = {}) {
    this.defaultProxyBase = defaultProxyBase;
    // The browser needs a CORS proxy for VRM calls, but the API server can talk to VRM directly.
    this._client = isApiMode ? null : new VRMClient();
  }

  /** Read fields from the DOM into a plain object */
  snapshotFromEls(els) {
    return {
      installationId: (els.vrmSite?.value || "").trim(),
      token: (els.vrmToken?.value || "").trim(),
      proxyBaseURL: (els.vrmProxy?.value || "").trim(),
    };
  }

  /** True if both installationId and token present */
  isConfigured(source) {
    const obj = source?.vrmSite ? this.snapshotFromEls(source) : source || {};
    const { installationId, token } = obj;
    return Boolean((installationId || "").trim() && (token || "").trim());
  }

  /** Apply creds/base to inputs and client */
  hydrate(els, obj = {}) {
    const installationId = obj.installationId || "";
    const token = obj.token || "";
    const proxyBaseURL = obj.proxyBaseURL || this.defaultProxyBase;

    if (els.vrmSite) els.vrmSite.value = installationId;
    if (els.vrmToken) els.vrmToken.value = token;
    if (els.vrmProxy) els.vrmProxy.value = proxyBaseURL;

    this._applyToClient({ installationId, token, proxyBaseURL });
  }

  /** Load from storage, then hydrate */
  hydrateFromStorage(els) {
    const stored = loadFromStorage(STORAGE_VRM_KEY) || null;
    this.hydrate(els, stored || {});
  }

  /** Save current DOM fields to storage */
  saveFromEls(els) {
    saveToStorage(STORAGE_VRM_KEY, this.snapshotFromEls(els));
  }

  /** Clear storage (does not clear inputs) */
  clearStorage() {
    removeFromStorage(STORAGE_VRM_KEY);
  }

  /** Fetch ESS settings from VRM (local or remote depending on runtime mode) */
  async fetchSettings(creds) {
    const normalised = this._normaliseCreds(creds);

    if (isApiMode) {
      const { settings } = await postJson("/vrm/settings", {
        installationId: normalised.installationId,
        token: normalised.token,
      });
      return settings;
    }

    this._applyToClient(normalised);
    return this._client.fetchDynamicEssSettings();
  }

  /** Fetch forecasts, prices and SoC from VRM */
  async fetchTimeseries(creds) {
    const normalised = this._normaliseCreds(creds);

    if (isApiMode) {
      return postJson("/vrm/timeseries", {
        installationId: normalised.installationId,
        token: normalised.token,
      });
    }

    this._applyToClient(normalised);
    const [forecasts, prices, soc] = await Promise.all([
      this._client.fetchForecasts(),
      this._client.fetchPrices(),
      this._client.fetchCurrentSoc(),
    ]);
    return { forecasts, prices, soc };
  }

  // ---- private
  _applyToClient({ installationId, token, proxyBaseURL }) {
    if (!this._client) return;
    this._client.setBaseURL(proxyBaseURL || this.defaultProxyBase); // VRMClient adds /v2
    this._client.setAuth({ installationId: installationId || "", token: token || "" });
  }

  _normaliseCreds(creds = {}) {
    return {
      installationId: (creds.installationId || "").trim(),
      token: (creds.token || "").trim(),
      proxyBaseURL: (creds.proxyBaseURL || "").trim(),
    };
  }
}
