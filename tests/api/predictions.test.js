import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../api/app.ts';

vi.mock('../../api/services/prediction-config-store.ts');
vi.mock('../../api/services/load-prediction-service.ts');
vi.mock('../../api/services/pv-prediction-service.ts');
vi.mock('../../api/services/settings-store.ts');
vi.mock('../../api/services/data-store.ts');

import { loadPredictionConfig, savePredictionConfig } from '../../api/services/prediction-config-store.ts';
import { runValidation, runForecast } from '../../api/services/load-prediction-service.ts';
import { runPvForecast } from '../../api/services/pv-prediction-service.ts';
import { loadSettings } from '../../api/services/settings-store.ts';
import { loadData, saveData } from '../../api/services/data-store.ts';

const mockConfig = {
  historyStart: '2025-11-01T00:00:00Z',
  sensors: [{ id: 'sensor.grid', name: 'Grid Import', unit: 'kWh' }],
  derived: [],
  validationWindow: { start: '2026-01-18T00:00:00Z', end: '2026-01-25T00:00:00Z' },
  activeConfig: { sensor: 'Grid Import', lookbackWeeks: 4, dayFilter: 'weekday-weekend', aggregation: 'mean' },
};

const mockSettings = {
  haUrl: 'ws://homeassistant.local:8123/api/websocket',
  haToken: 'test-token',
  dataSources: { load: 'vrm', pv: 'vrm' },
};

describe('GET /predictions/config', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    loadPredictionConfig.mockResolvedValue(mockConfig);
    savePredictionConfig.mockResolvedValue();
  });

  it('returns the config', async () => {
    const res = await request(app).get('/predictions/config');
    expect(res.status).toBe(200);
    expect(res.body.sensors).toHaveLength(1);
    expect(loadPredictionConfig).toHaveBeenCalled();
  });
});

describe('POST /predictions/config', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    loadPredictionConfig.mockResolvedValue(mockConfig);
    savePredictionConfig.mockResolvedValue();
  });

  it('merges and saves config', async () => {
    const res = await request(app)
      .post('/predictions/config')
      .send({ activeConfig: { sensor: 'Total Load', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean' } });

    expect(res.status).toBe(200);
    expect(res.body.config.activeConfig.sensor).toBe('Total Load');
    expect(savePredictionConfig).toHaveBeenCalled();
  });

  it('rejects non-object payload', async () => {
    const res = await request(app)
      .post('/predictions/config')
      .send([1, 2, 3]);

    expect(res.status).toBe(400);
  });
});

describe('POST /predictions/validate', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    loadPredictionConfig.mockResolvedValue(mockConfig);
    loadSettings.mockResolvedValue(mockSettings);
    savePredictionConfig.mockResolvedValue();
    runValidation.mockResolvedValue({
      sensorNames: ['Grid Import'],
      results: [
        {
          sensor: 'Grid Import',
          lookbackWeeks: 4,
          dayFilter: 'weekday-weekend',
          aggregation: 'mean',
          mae: 120.5,
          rmse: 180.2,
          mape: 15.3,
          n: 168,
          nSkipped: 0,
          validationPredictions: [],
        },
      ],
    });
  });

  it('returns validation results', async () => {
    const res = await request(app).post('/predictions/validate').send({});
    expect(res.status).toBe(200);
    expect(res.body.sensorNames).toContain('Grid Import');
    expect(res.body.results).toHaveLength(1);
    expect(runValidation).toHaveBeenCalled();
  });

  it('returns 400 when haUrl missing', async () => {
    loadSettings.mockResolvedValue({ ...mockSettings, haUrl: '' });
    const res = await request(app).post('/predictions/validate').send({});
    expect(res.status).toBe(400);
  });

  it('returns 400 when haToken missing', async () => {
    loadSettings.mockResolvedValue({ ...mockSettings, haToken: '' });
    const res = await request(app).post('/predictions/validate').send({});
    expect(res.status).toBe(400);
  });

  it('returns 502 on HA connection error', async () => {
    runValidation.mockRejectedValue(new Error('HA WebSocket error: connection refused'));
    const res = await request(app).post('/predictions/validate').send({});
    expect(res.status).toBe(502);
  });
});

describe('POST /predictions/forecast (combined)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    loadPredictionConfig.mockResolvedValue(mockConfig);
    savePredictionConfig.mockResolvedValue();
    loadSettings.mockResolvedValue(mockSettings);
    loadData.mockResolvedValue({});
    saveData.mockResolvedValue();
    runForecast.mockResolvedValue({
      forecast: { start: '2026-02-20T00:00:00.000Z', step: 15, values: new Array(96).fill(200) },
      recent: [],
    });
    runPvForecast.mockResolvedValue(null);
  });

  it('returns combined load + pv result', async () => {
    const res = await request(app).post('/predictions/forecast').send({});
    expect(res.status).toBe(200);
    expect(res.body.load).toBeTruthy();
    expect(res.body.load.forecast.values).toHaveLength(96);
    expect(res.body.load.forecast.step).toBe(15);
    expect(runForecast).toHaveBeenCalled();
  });

  it('returns load=null when activeConfig missing (graceful fallback)', async () => {
    loadPredictionConfig.mockResolvedValue({ ...mockConfig, activeConfig: null });
    const res = await request(app).post('/predictions/forecast').send({});
    expect(res.status).toBe(200);
    expect(res.body.load).toBeNull();
  });

  it('returns load=null on HA connection error (graceful fallback)', async () => {
    runForecast.mockRejectedValue(new Error('HA WebSocket timed out after 30000ms'));
    const res = await request(app).post('/predictions/forecast').send({});
    expect(res.status).toBe(200);
    expect(res.body.load).toBeNull();
  });
});

describe('POST /predictions/load/forecast', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    loadPredictionConfig.mockResolvedValue(mockConfig);
    savePredictionConfig.mockResolvedValue();
    loadSettings.mockResolvedValue(mockSettings);
    loadData.mockResolvedValue({});
    saveData.mockResolvedValue();
    runForecast.mockResolvedValue({
      forecast: { start: '2026-02-20T00:00:00.000Z', step: 15, values: new Array(96).fill(200) },
      recent: [],
    });
  });

  it('returns load forecast series', async () => {
    const res = await request(app).post('/predictions/load/forecast').send({});
    expect(res.status).toBe(200);
    expect(res.body.forecast.values).toHaveLength(96);
    expect(runForecast).toHaveBeenCalled();
  });

  it('returns 400 when activeConfig missing', async () => {
    loadPredictionConfig.mockResolvedValue({ ...mockConfig, activeConfig: null });
    const res = await request(app).post('/predictions/load/forecast').send({});
    expect(res.status).toBe(400);
  });

  it('returns 502 on HA connection error', async () => {
    runForecast.mockRejectedValue(new Error('HA WebSocket timed out after 30000ms'));
    const res = await request(app).post('/predictions/load/forecast').send({});
    expect(res.status).toBe(502);
  });
});
