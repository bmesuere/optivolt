import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { wsUrlToHttp, fetchHaEntityState } from '../../../api/services/ha-client.ts';

describe('wsUrlToHttp', () => {
  it('converts ws:// to http://', () => {
    expect(wsUrlToHttp('ws://homeassistant.local:8123/api/websocket'))
      .toBe('http://homeassistant.local:8123');
  });

  it('converts wss:// to https://', () => {
    expect(wsUrlToHttp('wss://ha.example.com/api/websocket'))
      .toBe('https://ha.example.com');
  });

  it('handles URL without /api/websocket suffix', () => {
    expect(wsUrlToHttp('ws://homeassistant.local:8123'))
      .toBe('http://homeassistant.local:8123');
  });
});

describe('fetchHaEntityState', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SUPERVISOR_TOKEN;
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it('fetches entity state via REST', async () => {
    const mockState = {
      entity_id: 'sensor.ev_battery_level',
      state: '75',
      attributes: { unit_of_measurement: '%' },
      last_changed: '2026-01-01T00:00:00Z',
      last_updated: '2026-01-01T00:00:00Z',
    };

    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockState),
    });

    const result = await fetchHaEntityState({
      haUrl: 'ws://homeassistant.local:8123/api/websocket',
      haToken: 'test-token',
      entityId: 'sensor.ev_battery_level',
    });

    expect(result).toEqual(mockState);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://homeassistant.local:8123/api/states/sensor.ev_battery_level',
      { headers: { Authorization: 'Bearer test-token' } },
    );
  });

  it('throws on non-ok response', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 404 });

    await expect(
      fetchHaEntityState({
        haUrl: 'ws://homeassistant.local:8123/api/websocket',
        haToken: 'test-token',
        entityId: 'sensor.unknown',
      }),
    ).rejects.toThrow('404');
  });

  it('uses supervisor proxy in add-on mode', async () => {
    process.env.SUPERVISOR_TOKEN = 'supervisor-secret';

    const mockState = { entity_id: 'sensor.foo', state: 'on', attributes: {}, last_changed: '', last_updated: '' };
    global.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(mockState) });

    await fetchHaEntityState({
      haUrl: 'ws://homeassistant.local:8123/api/websocket',
      haToken: 'user-token',
      entityId: 'sensor.foo',
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'http://supervisor/core/api/states/sensor.foo',
      { headers: { Authorization: 'Bearer supervisor-secret' } },
    );
  });
});
