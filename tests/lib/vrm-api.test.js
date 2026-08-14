import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VRMClient } from '../../lib/vrm-api.ts';

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
