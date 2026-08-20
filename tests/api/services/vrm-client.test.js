import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VRMClient } from '../../../api/services/vrm-client.ts';

describe('VRMClient HTTP requests', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('applies the configured request deadline', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    const client = new VRMClient({ installationId: '123', token: 'secret', timeoutMs: 2500 });

    await client._fetch('/test');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://vrmapi.victronenergy.com/v2/test',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('reports a clear timeout error', async () => {
    global.fetch.mockImplementation((_input, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const client = new VRMClient({ installationId: '123', token: 'secret', timeoutMs: 5 });

    await expect(client._fetch('/test')).rejects.toThrow('VRM API request timed out after 5ms');
  });

  it('sends the token header and surfaces error responses', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden', text: async () => 'nope' });
    const client = new VRMClient({ installationId: '123', token: 'secret' });

    await expect(client._fetch('/test')).rejects.toThrow('VRM 403 Forbidden: nope');
    expect(global.fetch.mock.calls[0][1].headers['X-Authorization']).toBe('Token secret');
  });

  it('requires a token and an installation id', async () => {
    await expect(new VRMClient({ installationId: '1' })._fetch('/test')).rejects.toThrow('Missing VRM API token');
    await expect(new VRMClient({ token: 't' }).fetchPrices()).rejects.toThrow('Missing installationId');
    await expect(new VRMClient({ token: 't' }).fetchForecasts()).rejects.toThrow('Missing installationId');
    await expect(new VRMClient({ token: 't' }).fetchDynamicEssSettings()).rejects.toThrow('Missing installationId');
  });

  it('applies setAuth / setBaseURL to subsequent requests', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    const client = new VRMClient();
    client.setAuth({ installationId: 77, token: 'tok' });
    client.setBaseURL('https://vrm.example.com/');

    await client._fetch('test');

    expect(client.installationId).toBe('77');
    expect(global.fetch.mock.calls[0][0]).toBe('https://vrm.example.com/v2/test');
  });
});

describe('VRMClient stats queries', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const startMs = Date.UTC(2026, 0, 15, 0, 0, 0);
  const win = { startMs, endMs: startMs + 3_600_000 };

  it('asks for 15-min prices over the requested window', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, records: { deGb: [[startMs, 0.2]], deGs: [[startMs, 0.1]] } }),
    });

    const prices = await new VRMClient({ installationId: '9', token: 't' }).fetchPrices(win);

    const url = new URL(global.fetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/v2/installations/9/stats');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      type: 'dynamic_ess_prices',
      interval: '15mins',
      start: String(startMs / 1000),
      end: String((startMs + 3_600_000) / 1000),
    });
    expect(prices.importPrice_cents_per_kwh[0]).toBeCloseTo(20);
  });

  it('asks for 15-min forecasts over the requested window', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ success: true, records: {} }) });

    await new VRMClient({ installationId: '9', token: 't' }).fetchForecasts(win);

    const url = new URL(global.fetch.mock.calls[0][0]);
    expect(url.searchParams.get('type')).toBe('forecast');
    expect(url.searchParams.get('interval')).toBe('15mins');
  });

  it('normalizes the DESS settings response', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { batteryCapacity: 10, chargePower: 5 } }),
    });

    const settings = await new VRMClient({ installationId: '9', token: 't' }).fetchDynamicEssSettings();

    expect(global.fetch.mock.calls[0][0]).toBe('https://vrmapi.victronenergy.com/v2/installations/9/dynamic-ess-settings');
    expect(settings.batteryCapacity_Wh).toBe(10000);
    expect(settings.chargePower_W).toBe(5000);
  });
});

describe('VRMClient.fetchForecasts — clampEndToData', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const H = 3_600_000;
  const startMs = Date.UTC(2026, 0, 15, 0, 0, 0);
  const win = { startMs, endMs: startMs + 6 * H };

  const mockResponse = (records) => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ success: true, records }) });
  };

  const client = () => new VRMClient({ installationId: '1', token: 't' });

  it('clamps the timeline to load coverage, not a longer PV series', async () => {
    mockResponse({
      // Load through 01:00 (covers 00:00–02:00); PV through 03:00.
      vrm_consumption_fc: [[startMs, 400], [startMs + H, 500]],
      solar_yield_forecast: [[startMs, 100], [startMs + H, 200], [startMs + 2 * H, 300], [startMs + 3 * H, 250]],
    });

    const forecasts = await client().fetchForecasts(win, { clampEndToData: true });

    // 2 h of 15-min slots — the PV tail must not stretch the timeline over zero-load hours.
    expect(forecasts.timestamps).toHaveLength(8);
    expect(forecasts.load_W.every(v => v > 0)).toBe(true);
  });

  it('returns an empty timeline when VRM returns no load data at all', async () => {
    mockResponse({
      solar_yield_forecast: [[startMs, 100], [startMs + H, 200]],
    });

    const forecasts = await client().fetchForecasts(win, { clampEndToData: true });
    expect(forecasts.timestamps).toHaveLength(0);
  });

  it('keeps the full requested window when clamping is off (default)', async () => {
    mockResponse({
      vrm_consumption_fc: [[startMs, 400]],
      solar_yield_forecast: [[startMs, 100]],
    });

    const forecasts = await client().fetchForecasts(win);
    expect(forecasts.timestamps).toHaveLength(24); // 6 h × 4, zero-filled past the data as before
  });
});
