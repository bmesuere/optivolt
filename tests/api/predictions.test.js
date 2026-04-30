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
  sensors: [{ id: 'sensor.grid', name: 'Grid Import', unit: 'kWh' }],
  derived: [],
  activeType: 'historical',
  historicalPredictor: { sensor: 'Grid Import', lookbackWeeks: 4, dayFilter: 'weekday-weekend', aggregation: 'mean' },
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
      .send({ historicalPredictor: { sensor: 'Total Load', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean' } });

    expect(res.status).toBe(200);
    expect(res.body.config.historicalPredictor.sensor).toBe('Total Load');
    expect(savePredictionConfig).toHaveBeenCalled();
  });

  it('rejects non-object payload', async () => {
    const res = await request(app)
      .post('/predictions/config')
      .send([1, 2, 3]);

    expect(res.status).toBe(400);
  });
});

describe('/predictions/adjustments', () => {
  const baseData = {
    load: { start: '2099-01-01T00:00:00.000Z', step: 15, values: [100, 100] },
    pv: { start: '2099-01-01T00:00:00.000Z', step: 15, values: [200, 200] },
    importPrice: { start: '2099-01-01T00:00:00.000Z', step: 15, values: [10, 10] },
    exportPrice: { start: '2099-01-01T00:00:00.000Z', step: 15, values: [5, 5] },
    soc: { timestamp: '2099-01-01T00:00:00.000Z', value: 50 },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    loadData.mockResolvedValue(baseData);
    saveData.mockResolvedValue();
  });

  it('creates a prediction adjustment', async () => {
    const res = await request(app)
      .post('/predictions/adjustments')
      .send({
        series: 'pv',
        mode: 'set',
        value_W: 0,
        start: '2099-01-01T00:00:00.000Z',
        end: '2099-01-01T01:00:00.000Z',
      });

    expect(res.status).toBe(201);
    expect(res.body.adjustment.series).toBe('pv');
    expect(saveData).toHaveBeenCalledWith(expect.objectContaining({
      predictionAdjustments: [expect.objectContaining({ series: 'pv', mode: 'set', value_W: 0 })],
    }));
  });

  it('returns active adjustments and prunes expired ones', async () => {
    loadData.mockResolvedValue({
      ...baseData,
      predictionAdjustments: [
        { id: 'expired', series: 'load', mode: 'add', value_W: 50, start: '2024-01-01T00:00:00.000Z', end: '2024-01-01T01:00:00.000Z', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' },
        { id: 'future', series: 'load', mode: 'add', value_W: 50, start: '2099-01-01T00:00:00.000Z', end: '2099-01-01T01:00:00.000Z', createdAt: '2099-01-01T00:00:00.000Z', updatedAt: '2099-01-01T00:00:00.000Z' },
      ],
    });

    const res = await request(app).get('/predictions/adjustments');

    expect(res.status).toBe(200);
    expect(res.body.adjustments.map(adj => adj.id)).toEqual(['future']);
    expect(saveData).toHaveBeenCalledWith(expect.objectContaining({
      predictionAdjustments: [expect.objectContaining({ id: 'future' })],
    }));
  });

  it('updates and deletes prediction adjustments', async () => {
    const existing = { id: 'adj-1', series: 'load', mode: 'add', value_W: 50, start: '2099-01-01T00:00:00.000Z', end: '2099-01-01T01:00:00.000Z', createdAt: '2099-01-01T00:00:00.000Z', updatedAt: '2099-01-01T00:00:00.000Z' };
    loadData.mockResolvedValue({ ...baseData, predictionAdjustments: [existing] });

    const patch = await request(app)
      .patch('/predictions/adjustments/adj-1')
      .send({ value_W: 125 });
    expect(patch.status).toBe(200);
    expect(patch.body.adjustment.value_W).toBe(125);

    const del = await request(app).delete('/predictions/adjustments/adj-1').send({});
    expect(del.status).toBe(200);
    expect(del.body.adjustments).toEqual([]);
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

  it('returns load=null when activeType missing (graceful fallback)', async () => {
    loadPredictionConfig.mockResolvedValue({ ...mockConfig, activeType: undefined });
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

  it('returns 400 when activeType missing', async () => {
    loadPredictionConfig.mockResolvedValue({ ...mockConfig, activeType: undefined });
    const res = await request(app).post('/predictions/load/forecast').send({});
    expect(res.status).toBe(400);
  });

  it('returns 502 on HA connection error', async () => {
    runForecast.mockRejectedValue(new Error('HA WebSocket timed out after 30000ms'));
    const res = await request(app).post('/predictions/load/forecast').send({});
    expect(res.status).toBe(502);
  });

  it('persists forecast when dataSources.load is api', async () => {
    loadSettings.mockResolvedValue({ ...mockSettings, dataSources: { load: 'api', pv: 'vrm' } });
    const res = await request(app).post('/predictions/load/forecast').send({});
    expect(res.status).toBe(200);
    expect(saveData).toHaveBeenCalledTimes(1);
    expect(saveData.mock.calls[0][0].load.values).toHaveLength(96);
  });

  it('skips saveData when dataSources.load is vrm', async () => {
    const res = await request(app).post('/predictions/load/forecast').send({});
    expect(res.status).toBe(200);
    expect(saveData).not.toHaveBeenCalled();
  });
});

describe('POST /predictions/forecast (combined) - persistence', () => {
  const loadForecast = { start: '2026-02-20T00:00:00.000Z', step: 15, values: new Array(96).fill(200) };
  const pvForecast = { start: '2026-02-20T00:00:00.000Z', step: 15, values: new Array(96).fill(500) };

  beforeEach(() => {
    vi.resetAllMocks();
    loadPredictionConfig.mockResolvedValue({ ...mockConfig, pvConfig: { latitude: 51.0, longitude: 4.5 } });
    savePredictionConfig.mockResolvedValue();
    loadSettings.mockResolvedValue({ ...mockSettings, dataSources: { load: 'api', pv: 'api' } });
    loadData.mockResolvedValue({ load: {}, pv: {} });
    saveData.mockResolvedValue();
    runForecast.mockResolvedValue({ forecast: loadForecast, recent: [] });
    runPvForecast.mockResolvedValue({ forecast: pvForecast, points: [], recent: [], metrics: {} });
  });

  it('calls saveData exactly once with both forecasts (race condition fix)', async () => {
    const res = await request(app).post('/predictions/forecast').send({});
    expect(res.status).toBe(200);
    expect(saveData).toHaveBeenCalledTimes(1);
    expect(saveData.mock.calls[0][0].load).toEqual(loadForecast);
    expect(saveData.mock.calls[0][0].pv).toEqual(pvForecast);
  });

  it('returns adjusted forecasts while persisting raw forecasts', async () => {
    const futureLoadForecast = { start: '2099-01-01T00:00:00.000Z', step: 15, values: [100, 100, 100, 100] };
    const adjustment = {
      id: 'adj-1',
      series: 'load',
      mode: 'add',
      value_W: 50,
      start: '2099-01-01T00:15:00.000Z',
      end: '2099-01-01T00:45:00.000Z',
      createdAt: '2099-01-01T00:00:00.000Z',
      updatedAt: '2099-01-01T00:00:00.000Z',
    };
    runForecast.mockResolvedValue({ forecast: futureLoadForecast, recent: [] });
    runPvForecast.mockResolvedValue(null);
    loadData.mockResolvedValue({
      load: { start: '2099-01-01T00:00:00.000Z', step: 15, values: [] },
      pv: { start: '2099-01-01T00:00:00.000Z', step: 15, values: [] },
      importPrice: { start: '2099-01-01T00:00:00.000Z', step: 15, values: [] },
      exportPrice: { start: '2099-01-01T00:00:00.000Z', step: 15, values: [] },
      soc: { timestamp: '2099-01-01T00:00:00.000Z', value: 50 },
      predictionAdjustments: [adjustment],
    });

    const res = await request(app).post('/predictions/forecast').send({});

    expect(res.status).toBe(200);
    expect(saveData.mock.calls[0][0].load).toEqual(futureLoadForecast);
    expect(res.body.load.rawForecast.values).toEqual([100, 100, 100, 100]);
    expect(res.body.load.forecast.values).toEqual([100, 150, 150, 100]);
  });

  it('saves only load when dataSources.pv is vrm', async () => {
    loadSettings.mockResolvedValue({ ...mockSettings, dataSources: { load: 'api', pv: 'vrm' } });
    const res = await request(app).post('/predictions/forecast').send({});
    expect(res.status).toBe(200);
    expect(saveData).toHaveBeenCalledTimes(1);
    expect(saveData.mock.calls[0][0].load).toEqual(loadForecast);
  });

  it('saves only pv when load branch fails', async () => {
    runForecast.mockRejectedValue(new Error('HA WebSocket timed out after 30000ms'));
    const res = await request(app).post('/predictions/forecast').send({});
    expect(res.status).toBe(200);
    expect(saveData).toHaveBeenCalledTimes(1);
    expect(saveData.mock.calls[0][0].pv).toEqual(pvForecast);
  });

  it('skips saveData when both dataSources are vrm', async () => {
    loadSettings.mockResolvedValue({ ...mockSettings, dataSources: { load: 'vrm', pv: 'vrm' } });
    const res = await request(app).post('/predictions/forecast').send({});
    expect(res.status).toBe(200);
    expect(saveData).not.toHaveBeenCalled();
  });

  it('returns 200 with forecast results even when persistence fails', async () => {
    saveData.mockRejectedValue(new Error('disk full'));
    const res = await request(app).post('/predictions/forecast').send({});
    expect(res.status).toBe(200);
    expect(res.body.load).toBeTruthy();
    expect(res.body.pv).toBeTruthy();
  });
});
