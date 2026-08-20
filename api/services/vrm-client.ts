/**
 * vrm-client.ts
 *
 * Minimal HTTP client for the Victron VRM API.
 * Uses the pure window math and response parsers from lib/vrm-payloads.ts.
 *
 * Example:
 *
 * const vrm = new VRMClient({ installationId: '123456', token: '<token>' });
 * const settings = await vrm.fetchDynamicEssSettings();
 * const forecasts = await vrm.fetchForecasts();  // defaults to last full hour → day-ahead end
 * const prices = await vrm.fetchPrices();
 */

import { fetchWithTimeout } from '../../lib/fetch-utils.ts';
import {
  ensureWindow,
  parseDessSettings,
  parseForecastsResponse,
  parsePricesResponse,
  type VRMDessSettings,
  type VRMForecasts,
  type VRMPrices,
  type VRMWindow,
} from '../../lib/vrm-payloads.ts';

export type {
  VRMDessFlags,
  VRMDessLimits,
  VRMDessSettings,
  VRMForecasts,
  VRMPrices,
  VRMWindow,
} from '../../lib/vrm-payloads.ts';

interface VRMClientConfig {
  baseURL?: string;
  installationId?: string;
  token?: string;
  timeoutMs?: number;
}

interface FetchOptions {
  query?: Record<string, string | number | null | undefined>;
  method?: string;
  body?: unknown;
}

export class VRMClient {
  baseURL: string;
  installationId: string;
  token: string;
  defaultIntervalMins: number;
  timeoutMs: number;

  constructor({ baseURL, installationId, token, timeoutMs = 15000 }: VRMClientConfig = {}) {
    this.baseURL = (baseURL || 'https://vrmapi.victronenergy.com').replace(/\/+$/, '') + "/v2";
    this.installationId = installationId || '';
    this.token = token || '';
    this.defaultIntervalMins = 15;
    this.timeoutMs = timeoutMs;
  }

  setAuth({ installationId, token }: { installationId?: string | null; token?: string | null } = {}): void {
    if (installationId != null) this.installationId = String(installationId);
    if (token != null) this.token = token;
  }

  setBaseURL(baseURL: string): void {
    this.baseURL = String(baseURL || '').replace(/\/+$/, '') + "/v2";
  }

  // ----------------------------- Core fetch helper -----------------------------

  async _fetch(path: string, { query = {}, method = 'GET', body }: FetchOptions = {}): Promise<unknown> {
    if (!this.token) throw new Error('Missing VRM API token');
    const url = new URL(this.baseURL + (path.startsWith('/') ? path : `/${path}`));
    Object.entries(query).forEach(([k, v]) => v != null && url.searchParams.set(k, String(v)));

    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'X-Authorization': `Token ${this.token}`
    };
    const init: RequestInit = { method, headers };
    if (body != null) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await fetchWithTimeout(
      url.toString(),
      init,
      { timeoutMs: this.timeoutMs, label: 'VRM API request' },
    );
    if (!res.ok) {
      let txt = '';
      try { txt = await res.text(); } catch { /* ignore */ }
      throw new Error(`VRM ${res.status} ${res.statusText}: ${txt || 'Request failed'}`);
    }
    return res.json();
  }

  /** GET /installations/{id}/dynamic-ess-settings */
  async fetchDynamicEssSettings(): Promise<VRMDessSettings> {
    if (!this.installationId) throw new Error('Missing installationId');
    return parseDessSettings(await this._fetch(`/installations/${this.installationId}/dynamic-ess-settings`));
  }

  /** GET /installations/{id}/stats?type=forecast&interval=15mins */
  async fetchForecasts(opts: Partial<VRMWindow> = {}, { clampEndToData = false } = {}): Promise<VRMForecasts> {
    if (!this.installationId) throw new Error('Missing installationId');

    const win = ensureWindow(opts);
    const data = await this._fetch(`/installations/${this.installationId}/stats`, {
      query: { type: 'forecast', interval: '15mins', start: win.startSec, end: win.endSec },
    });
    return parseForecastsResponse(data, win, { clampEndToData });
  }

  /** GET /installations/{id}/stats?type=dynamic_ess_prices&interval=15mins */
  async fetchPrices(opts: Partial<VRMWindow> = {}): Promise<VRMPrices> {
    if (!this.installationId) throw new Error('Missing installationId');

    const win = ensureWindow(opts);
    const data = await this._fetch(`/installations/${this.installationId}/stats`, {
      query: { type: 'dynamic_ess_prices', interval: '15mins', start: win.startSec, end: win.endSec },
    });
    return parsePricesResponse(data, win);
  }
}
