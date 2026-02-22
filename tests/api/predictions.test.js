import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../api/app.js';

vi.mock('../../api/services/prediction-config-store.js');
vi.mock('../../api/services/prediction-service.js');

import { loadPredictionConfig, savePredictionConfig } from '../../api/services/prediction-config-store.js';
import { runValidation, runForecast } from '../../api/services/prediction-service.js';

const mockConfig = {
  haUrl: 'ws://homeassistant.local:8123/api/websocket',
  haToken: 'test-token',
  historyStart: '2025-11-01T00:00:00Z',
  sensors: [{ id: 'sensor.grid', name: 'Grid Import', unit: 'kWh' }],
  derived: [],
  validationWindow: { start: '2026-01-18T00:00:00Z', end: '2026-01-25T00:00:00Z' },
  activeConfig: { sensor: 'Grid Import', lookbackWeeks: 4, dayFilter: 'weekday-weekend', aggregation: 'mean' },
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
    expect(res.body.haUrl).toBe(mockConfig.haUrl);
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
      .send({ haUrl: 'ws://new-url:8123/api/websocket' });

    expect(res.status).toBe(200);
    expect(res.body.config.haUrl).toBe('ws://new-url:8123/api/websocket');
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
    loadPredictionConfig.mockResolvedValue({ ...mockConfig, haUrl: '' });
    const res = await request(app).post('/predictions/validate').send({});
    expect(res.status).toBe(400);
  });

  it('returns 400 when haToken missing', async () => {
    loadPredictionConfig.mockResolvedValue({ ...mockConfig, haToken: '' });
    const res = await request(app).post('/predictions/validate').send({});
    expect(res.status).toBe(400);
  });

  it('returns 502 on HA connection error', async () => {
    runValidation.mockRejectedValue(new Error('HA WebSocket error: connection refused'));
    const res = await request(app).post('/predictions/validate').send({});
    expect(res.status).toBe(502);
  });
});

describe('POST /predictions/forecast', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    loadPredictionConfig.mockResolvedValue(mockConfig);
    savePredictionConfig.mockResolvedValue();
    runForecast.mockResolvedValue({
      start: '2026-02-20T00:00:00.000Z',
      step: 15,
      values: new Array(96).fill(200),
    });
  });

  it('returns forecast series', async () => {
    const res = await request(app).post('/predictions/forecast').send({});
    expect(res.status).toBe(200);
    expect(res.body.values).toHaveLength(96);
    expect(res.body.step).toBe(15);
    expect(runForecast).toHaveBeenCalled();
  });

  it('returns 400 when activeConfig missing', async () => {
    loadPredictionConfig.mockResolvedValue({ ...mockConfig, activeConfig: null });
    const res = await request(app).post('/predictions/forecast').send({});
    expect(res.status).toBe(400);
  });

  it('returns 502 on HA connection error', async () => {
    runForecast.mockRejectedValue(new Error('HA WebSocket timed out after 30000ms'));
    const res = await request(app).post('/predictions/forecast').send({});
    expect(res.status).toBe(502);
  });
});
