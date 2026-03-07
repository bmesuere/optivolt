import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { refreshSeriesFromVrmAndPersist } from '../../../api/services/vrm-refresh.ts';
import { loadSettings, saveSettings } from '../../../api/services/settings-store.ts';
import { loadData, saveData } from '../../../api/services/data-store.ts';
import * as mqttService from '../../../api/services/mqtt-service.ts';

// 1. Hoist mocks for VRMClient
const { mockFetchForecasts, mockFetchPrices } = vi.hoisted(() => {
  return {
    mockFetchForecasts: vi.fn(),
    mockFetchPrices: vi.fn(),
  };
});

vi.mock('../../../lib/vrm-api.ts', () => {
  return {
    VRMClient: class {
      constructor() {
        this.fetchForecasts = mockFetchForecasts;
        this.fetchPrices = mockFetchPrices;
      }
    }
  };
});

// Mock for fetchHaEntityState
const { mockFetchHaEntityState } = vi.hoisted(() => ({
  mockFetchHaEntityState: vi.fn(),
}));

vi.mock('../../../api/services/ha-client.ts', () => ({
  fetchHaEntityState: mockFetchHaEntityState,
  wsUrlToHttp: (url) => url.replace(/^ws:\/\//, 'http://').replace(/\/api\/websocket$/, ''),
}));

vi.mock('../../../api/services/settings-store.ts');
vi.mock('../../../api/services/data-store.ts');
vi.mock('../../../api/services/mqtt-service.ts');

const BASE_TIMESTAMP = '2024-01-01T00:00:00.000Z';

const baseData = {
  load: { start: BASE_TIMESTAMP, values: [] },
  pv: { start: BASE_TIMESTAMP, values: [] },
  importPrice: { start: BASE_TIMESTAMP, values: [] },
  exportPrice: { start: BASE_TIMESTAMP, values: [] },
  soc: { value: 50, timestamp: BASE_TIMESTAMP },
};

describe('vrm-refresh EV state fetching', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mqttService.readVictronSocPercent.mockResolvedValue(50);
    mockFetchForecasts.mockResolvedValue({ timestamps: [BASE_TIMESTAMP], load_W: [1], pv_W: [2], step_minutes: 15 });
    mockFetchPrices.mockResolvedValue({ timestamps: [BASE_TIMESTAMP], importPrice_cents_per_kwh: [3], exportPrice_cents_per_kwh: [4], step_minutes: 15 });

    loadData.mockResolvedValue({ ...baseData });
    saveData.mockResolvedValue();
    saveSettings.mockResolvedValue();

    process.env.VRM_INSTALLATION_ID = '123';
    process.env.VRM_TOKEN = 'abc';
  });

  afterEach(() => {
    delete process.env.VRM_INSTALLATION_ID;
    delete process.env.VRM_TOKEN;
  });

  it('skips EV fetch when ev source is none', async () => {
    loadSettings.mockResolvedValue({
      dataSources: { prices: 'vrm', load: 'vrm', pv: 'vrm', soc: 'mqtt', ev: 'none' },
      haUrl: 'ws://ha.local:8123/api/websocket',
      haToken: 'tok',
      evSocSensor: 'sensor.ev_soc',
      evPlugSensor: 'binary_sensor.ev_plug',
    });

    await refreshSeriesFromVrmAndPersist();

    expect(mockFetchHaEntityState).not.toHaveBeenCalled();
    expect(saveData).toHaveBeenCalledWith(expect.not.objectContaining({ evState: expect.anything() }));
  });

  it('fetches EV state from HA when ev source is ha', async () => {
    loadSettings.mockResolvedValue({
      dataSources: { prices: 'vrm', load: 'vrm', pv: 'vrm', soc: 'mqtt', ev: 'ha' },
      haUrl: 'ws://ha.local:8123/api/websocket',
      haToken: 'tok',
      evSocSensor: 'sensor.ev_soc',
      evPlugSensor: 'binary_sensor.ev_plug',
    });

    mockFetchHaEntityState
      .mockResolvedValueOnce({ entity_id: 'sensor.ev_soc', state: '75', attributes: {}, last_changed: BASE_TIMESTAMP, last_updated: BASE_TIMESTAMP })
      .mockResolvedValueOnce({ entity_id: 'binary_sensor.ev_plug', state: 'on', attributes: { current_power_w: 11000 }, last_changed: BASE_TIMESTAMP, last_updated: BASE_TIMESTAMP });

    await refreshSeriesFromVrmAndPersist();

    expect(mockFetchHaEntityState).toHaveBeenCalledTimes(2);
    expect(saveData).toHaveBeenCalledWith(expect.objectContaining({
      evState: expect.objectContaining({ soc_percent: 75, plugged: true }),
    }));
  });

  it('falls back to existing evState when HA fetch fails', async () => {
    const existingEvState = { soc_percent: 60, plugged: false, maxPower_W: 0, timestamp: BASE_TIMESTAMP };
    loadData.mockResolvedValue({ ...baseData, evState: existingEvState });

    loadSettings.mockResolvedValue({
      dataSources: { prices: 'vrm', load: 'vrm', pv: 'vrm', soc: 'mqtt', ev: 'ha' },
      haUrl: 'ws://ha.local:8123/api/websocket',
      haToken: 'tok',
      evSocSensor: 'sensor.ev_soc',
      evPlugSensor: 'binary_sensor.ev_plug',
    });

    mockFetchHaEntityState.mockRejectedValue(new Error('HA unavailable'));

    await refreshSeriesFromVrmAndPersist();

    expect(saveData).toHaveBeenCalledWith(expect.objectContaining({
      evState: existingEvState,
    }));
  });
});
