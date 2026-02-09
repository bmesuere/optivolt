import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import app from '../../api/app.js';

// Mock dependencies
vi.mock('../../api/services/settings-store.js');
vi.mock('../../api/services/data-store.js');
vi.mock('../../api/services/vrm-refresh.js');
vi.mock('../../api/services/mqtt-service.js');

import { loadSettings } from '../../api/services/settings-store.js';
import { loadData } from '../../api/services/data-store.js';
import { refreshSeriesFromVrmAndPersist } from '../../api/services/vrm-refresh.js';
import { setDynamicEssSchedule } from '../../api/services/mqtt-service.js';

const mockSettings = {
  stepSize_m: 60,
  batteryCapacity_Wh: 10000,
  minSoc_percent: 20,
  maxSoc_percent: 100,
  maxChargePower_W: 1000,
  maxDischargePower_W: 1000,
  maxGridImport_W: 2000,
  maxGridExport_W: 2000,
  chargeEfficiency_percent: 100,
  dischargeEfficiency_percent: 100,
  batteryCost_cent_per_kWh: 0,
  terminalSocValuation: "zero",
  terminalSocCustomPrice_cents_per_kWh: 0
};

const mockData = {
  // 5 hours of data
  load: {
    start: "2024-01-01T00:00:00.000Z",
    step: 15,
    values: [500, 500, 500, 500, 500]
  },
  pv: {
    start: "2024-01-01T00:00:00.000Z",
    step: 15,
    values: [0, 0, 0, 0, 0]
  },
  importPrice: {
    start: "2024-01-01T00:00:00.000Z",
    step: 15,
    values: [10, 10, 10, 10, 10]
  },
  exportPrice: {
    start: "2024-01-01T00:00:00.000Z",
    step: 15,
    values: [5, 5, 5, 5, 5]
  },
  soc: {
    timestamp: "2024-01-01T00:00:00.000Z",
    value: 20
  },
  // Legacy field for safety during transition, though not used by new logic
  initialSoc_percent: 20
};

describe('Integration: API', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));

    vi.resetAllMocks();
    loadSettings.mockResolvedValue({ ...mockSettings });
    loadData.mockResolvedValue({ ...mockData });
    refreshSeriesFromVrmAndPersist.mockResolvedValue();
    setDynamicEssSchedule.mockResolvedValue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('GET /health returns 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Optivolt API is running.' });
  });

  it('GET /settings returns merged settings', async () => {
    // We mocked loadSettings to return mockSettings
    // But endpoint merges with defaults. Since mockSettings covers most, it should appear.
    const res = await request(app).get('/settings');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stepSize_m: 60 });
  });

  it('POST /calculate runs the solver', async () => {
    const res = await request(app)
      .post('/calculate')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.solverStatus).toBe('Optimal');
    expect(res.body.rows).toHaveLength(5);
    expect(loadSettings).toHaveBeenCalled();
    expect(loadData).toHaveBeenCalled();
  });

  it('POST /calculate with updateData calls VRM refresh', async () => {
    const res = await request(app)
      .post('/calculate')
      .send({ updateData: true });

    expect(res.status).toBe(200);
    expect(refreshSeriesFromVrmAndPersist).toHaveBeenCalled();
  });

  it('POST /calculate with writeToVictron calls MQTT service', async () => {
    const res = await request(app)
      .post('/calculate')
      .send({ writeToVictron: true });

    expect(res.status).toBe(200);
    expect(setDynamicEssSchedule).toHaveBeenCalled();
  });
});
