// app/vrm.js
import { VRMClient } from "../lib/vrm-api.js";
import { STORAGE_VRM_KEY, saveToStorage, loadFromStorage, removeFromStorage } from "./storage.js";

export class VRMManager {
  /**
   * @param {object} opts
   * @param {string} [opts.defaultProxyBase]
   */
  constructor({ defaultProxyBase = "https://vrm-cors-proxy.mesuerebart.workers.dev" } = {}) {
    this.defaultProxyBase = defaultProxyBase;
    this._client = new VRMClient();
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

  /** Ensure the client uses the current DOM values */
  refreshClientFromEls(els) {
    this._applyToClient(this.snapshotFromEls(els));
  }

  /** Expose the underlying client */
  get client() {
    return this._client;
  }

  // ---- private
  _applyToClient({ installationId, token, proxyBaseURL }) {
    this._client.setBaseURL(proxyBaseURL || this.defaultProxyBase); // VRMClient adds /v2
    this._client.setAuth({ installationId: installationId || "", token: token || "" });
  }
}
