import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import app from '../../api/app.ts';

// Mock dependencies
vi.mock('../../api/services/settings-store.ts');
vi.mock('../../api/services/data-store.ts');
vi.mock('../../api/services/vrm-refresh.ts');
vi.mock('../../api/services/mqtt-service.ts');

import { loadSettings, saveSettings, loadDefaultSettings } from '../../api/services/settings-store.ts';
import { loadData } from '../../api/services/data-store.ts';
import { refreshSeriesFromVrmAndPersist } from '../../api/services/vrm-refresh.ts';
import { setDynamicEssSchedule } from '../../api/services/mqtt-service.ts';

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
  idleDrain_W: 0,
  terminalSocValuation: "zero",
  terminalSocCustomPrice_cents_per_kWh: 0
};

const mockData = {
  // 5 hours of data
  load: {
    start: "2024-01-01T00:00:00.000Z",
    step: 60,
    values: [500, 500, 500, 500, 500]
  },
  pv: {
    start: "2024-01-01T00:00:00.000Z",
    step: 60,
    values: [0, 0, 0, 0, 0]
  },
  importPrice: {
    start: "2024-01-01T00:00:00.000Z",
    step: 60,
    values: [10, 10, 10, 10, 10]
  },
  exportPrice: {
    start: "2024-01-01T00:00:00.000Z",
    step: 60,
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
    // The POST whitelist iterates the defaults' keys, so haToken/dataSources must be present.
    loadDefaultSettings.mockResolvedValue({
      ...mockSettings,
      haToken: '',
      dataSources: { load: 'vrm', pv: 'vrm', prices: 'vrm', soc: 'mqtt' },
    });
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

  describe('haToken redaction', () => {
    // Hardcoded so an accidental change to HA_TOKEN_SENTINEL breaks the tests.
    const SENTINEL = '__optivolt_redacted__';

    it('GET /settings returns the sentinel instead of the stored token', async () => {
      loadSettings.mockResolvedValue({ ...mockSettings, haToken: 'secret-ha-token' });

      const res = await request(app).get('/settings');

      expect(res.status).toBe(200);
      expect(res.body.haToken).toBe(SENTINEL);
      expect(JSON.stringify(res.body)).not.toContain('secret-ha-token');
    });

    it('GET /settings returns an empty haToken when none is stored', async () => {
      loadSettings.mockResolvedValue({ ...mockSettings, haToken: '' });

      const res = await request(app).get('/settings');

      expect(res.status).toBe(200);
      expect(res.body.haToken).toBe('');
    });

    it('POST /settings with the sentinel keeps the stored token', async () => {
      loadSettings.mockResolvedValue({ ...mockSettings, haToken: 'secret-ha-token' });

      const res = await request(app)
        .post('/settings')
        .send({ haToken: SENTINEL, maxSoc_percent: 90 });

      expect(res.status).toBe(200);
      expect(saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ haToken: 'secret-ha-token', maxSoc_percent: 90 }),
      );
      expect(res.body.settings.haToken).toBe(SENTINEL);
      expect(JSON.stringify(res.body)).not.toContain('secret-ha-token');
    });

    it('POST /settings with a new token replaces the stored one', async () => {
      loadSettings.mockResolvedValue({ ...mockSettings, haToken: 'secret-ha-token' });

      const res = await request(app).post('/settings').send({ haToken: 'new-ha-token' });

      expect(res.status).toBe(200);
      expect(saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ haToken: 'new-ha-token' }),
      );
      expect(res.body.settings.haToken).toBe(SENTINEL);
      expect(JSON.stringify(res.body)).not.toContain('new-ha-token');
    });

    it('POST /settings with an empty string clears the stored token', async () => {
      // The response echoes a re-read: first call is prevSettings, second the cleared form.
      loadSettings
        .mockResolvedValueOnce({ ...mockSettings, haToken: 'secret-ha-token' })
        .mockResolvedValueOnce({ ...mockSettings, haToken: '' });

      const res = await request(app).post('/settings').send({ haToken: '' });

      expect(res.status).toBe(200);
      expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ haToken: '' }));
      expect(res.body.settings.haToken).toBe('');
    });
  });

  it('POST /calculate runs the solver', async () => {
    const res = await request(app)
      .post('/calculate')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.solverStatus).toBe('Optimal');
    expect(res.body.rows).toHaveLength(5);
    // Canonical day-ahead boundary for the client's "Standard" view slicing.
    expect(res.body.standardWindowEndMs).toBeTypeOf('number');
    expect(res.body.standardWindowEndMs).toBeGreaterThan(Date.now() - 24 * 3_600_000);
    expect(res.body.rebalanceNudge).toEqual({
      lastFullSocAt: null,
      daysSinceLastFullSoc: null,
      rebalanceRecommended: false,
      thresholdDays: 10,
    });
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

  it.each(['updateData', 'writeToVictron'])('rejects non-boolean %s values', async (field) => {
    vi.useRealTimers();
    const res = await request(app)
      .post('/calculate')
      .send({ [field]: 'false' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`${field} must be a boolean`);
    expect(refreshSeriesFromVrmAndPersist).not.toHaveBeenCalled();
    expect(setDynamicEssSchedule).not.toHaveBeenCalled();
  });
});
