import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { refreshSeriesFromVrmAndPersist } from '../../../api/services/vrm-refresh.js';
import { loadSettings, saveSettings } from '../../../api/services/settings-store.js';
import { loadData, saveData } from '../../../api/services/data-store.js';
import * as mqttService from '../../../api/services/mqtt-service.js';

// 1. Define hoisted mocks so they are available inside vi.mock factory
const { mockFetchForecasts, mockFetchPrices } = vi.hoisted(() => {
  return {
    mockFetchForecasts: vi.fn(),
    mockFetchPrices: vi.fn(),
  };
});

// 2. Mock VRMClient manually using a class to support 'new'
vi.mock('../../../lib/vrm-api.js', () => {
  return {
    VRMClient: class {
      constructor() {
        this.fetchForecasts = mockFetchForecasts;
        this.fetchPrices = mockFetchPrices;
      }
    }
  };
});

// Mock other dependencies
vi.mock('../../../api/services/settings-store.js');
vi.mock('../../../api/services/data-store.js');
vi.mock('../../../api/services/mqtt-service.js');

describe('vrm-refresh logic with custom data', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock behaviors
    mqttService.readVictronSocPercent.mockResolvedValue(50);

    // Default Settings
    loadSettings.mockResolvedValue({
      dataSources: { prices: 'vrm', load: 'vrm', pv: 'vrm', soc: 'mqtt' }
    });
    saveSettings.mockResolvedValue();

    // Default Data
    loadData.mockResolvedValue({
      load: { start: '2024-01-01T00:00:00.000Z', values: [] },
      pv: { start: '2024-01-01T00:00:00.000Z', values: [] },
      importPrice: { start: '2024-01-01T00:00:00.000Z', values: [] },
      exportPrice: { start: '2024-01-01T00:00:00.000Z', values: [] },
      soc: { value: 50, timestamp: '2024-01-01T00:00:00.000Z' }
    });
    saveData.mockResolvedValue();

    process.env.VRM_INSTALLATION_ID = '123';
    process.env.VRM_TOKEN = 'abc';
  });

  afterEach(() => {
    delete process.env.VRM_INSTALLATION_ID;
    delete process.env.VRM_TOKEN;
  });

  it('fetches everything when set to VRM (default)', async () => {
    // Setup mocks returning valid data
    mockFetchForecasts.mockResolvedValue({ timestamps: ['2024-01-01T10:00:00.000Z'], load_W: [1], pv_W: [2] });
    mockFetchPrices.mockResolvedValue({ timestamps: ['2024-01-01T10:00:00.000Z'], importPrice_cents_per_kwh: [3], exportPrice_cents_per_kwh: [4] });

    await refreshSeriesFromVrmAndPersist();

    expect(mockFetchForecasts).toHaveBeenCalled();
    expect(mockFetchPrices).toHaveBeenCalled();
    expect(saveData).toHaveBeenCalledWith(expect.objectContaining({
      load: expect.objectContaining({ start: '2024-01-01T10:00:00.000Z' }),
      importPrice: expect.objectContaining({ start: '2024-01-01T10:00:00.000Z' })
    }));
  });

  it('skips prices when set to manual', async () => {
    loadSettings.mockResolvedValue({
      dataSources: { prices: 'api', load: 'vrm', pv: 'vrm' }
    });

    mockFetchForecasts.mockResolvedValue({ timestamps: ['2024-01-01T10:00:00.000Z'], load_W: [], pv_W: [] });

    await refreshSeriesFromVrmAndPersist();

    expect(mockFetchForecasts).toHaveBeenCalled();
    expect(mockFetchPrices).not.toHaveBeenCalled();

    // Should preserve OLD prices
    expect(saveData).toHaveBeenCalledWith(expect.objectContaining({
      load: expect.objectContaining({ start: '2024-01-01T10:00:00.000Z' }),
      importPrice: expect.objectContaining({ start: '2024-01-01T00:00:00.000Z' }), // Preserved
    }));
  });

  it('skips forecasts when load/pv set to manual', async () => {
    loadSettings.mockResolvedValue({
      dataSources: { prices: 'vrm', load: 'api', pv: 'api' }
    });
    mockFetchPrices.mockResolvedValue({ timestamps: ['2024-01-01T10:00:00.000Z'], importPrice_cents_per_kwh: [], exportPrice_cents_per_kwh: [] });

    await refreshSeriesFromVrmAndPersist();

    expect(mockFetchForecasts).not.toHaveBeenCalled();
    expect(mockFetchPrices).toHaveBeenCalled();

    expect(saveData).toHaveBeenCalledWith(expect.objectContaining({
      load: expect.objectContaining({ start: '2024-01-01T00:00:00.000Z' }), // Preserved
      importPrice: expect.objectContaining({ start: '2024-01-01T10:00:00.000Z' }),
    }));
  });
  it('skips SoC fetch when soc set to api', async () => {
    loadSettings.mockResolvedValue({
      dataSources: { prices: 'vrm', load: 'vrm', pv: 'vrm', soc: 'api' }
    });

    await refreshSeriesFromVrmAndPersist();

    expect(mqttService.readVictronSocPercent).not.toHaveBeenCalled();
    expect(saveData).toHaveBeenCalledWith(expect.objectContaining({
      soc: expect.objectContaining({ value: 50, timestamp: '2024-01-01T00:00:00.000Z' }) // Strictly Preserved
    }));
  });
});
