import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { loadData, saveData } from '../../api/services/data-store.js';
import { loadSettings, saveSettings } from '../../api/services/settings-store.js';
import dataRouter from '../../api/routes/data.js';
import calculateRouter from '../../api/routes/calculate.js';

// Mock dependencies
vi.mock('../../api/services/data-store.js');
vi.mock('../../api/services/settings-store.js');
vi.mock('../../api/services/vrm-refresh.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    refreshSeriesFromVrmAndPersist: vi.fn(),
  };
});
vi.mock('../../api/services/planner-service.js', () => ({
  planAndMaybeWrite: vi.fn().mockResolvedValue({
    cfg: { initialSoc_percent: 50 },
    data: { tsStart: '2024-01-01T00:00:00Z', load: { start: '2024-01-01T00:00:00Z' } },
    result: { Status: 'Optimal', ObjectiveValue: 0 },
    rows: [],
    summary: {},
    timing: { startMs: 0 }
  })
}));


const app = express();
app.use(express.json());
app.use('/data', dataRouter);
app.use('/calculate', calculateRouter);

// Error handling middleware for tests
app.use((err, req, res, _next) => {
  const status = err.statusCode || err.status || 500;
  res.status(status).json({ message: err.message });
});

describe('Custom Data Injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mocks
    loadData.mockResolvedValue({
      load: { start: '2024-01-01T00:00:00Z', values: [] },
      importPrice: { start: '2024-01-01T00:00:00Z', values: [10, 10] },
      exportPrice: { start: '2024-01-01T00:00:00Z', values: [5, 5] },
      soc: { value: 50, timestamp: '2024-01-01T00:00:00Z' }
    });
    saveData.mockResolvedValue();
    loadSettings.mockResolvedValue({
      dataSources: { prices: 'api', load: 'api', pv: 'api', soc: 'api' } // allow custom data in tests
    });
    saveSettings.mockResolvedValue();
  });

  it('GET /data should return current data', async () => {
    const res = await request(app).get('/data');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('load');
  });

  it('POST /data should update specific keys', async () => {
    const customPrices = {
      start: '2024-02-01T00:00:00Z',
      step: 60,
      values: [99, 99, 99]
    };

    const res = await request(app)
      .post('/data')
      .send({ importPrice: customPrices });

    expect(res.status).toBe(200);
    expect(saveData).toHaveBeenCalledWith(expect.objectContaining({
      importPrice: expect.objectContaining({ values: [99, 99, 99] }),
      // Should preserve other keys from default mock
      exportPrice: expect.objectContaining({ values: [5, 5] })
    }));
  });

  it('POST /data should reject invalid keys', async () => {
    const res = await request(app)
      .post('/data')
      .send({ invalidKey: {} });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('No valid data keys provided or settings are not set to API');
    expect(saveData).not.toHaveBeenCalled();
  });

  it('POST /data should reject valid keys if setting is not API', async () => {
    loadSettings.mockResolvedValue({
      dataSources: { prices: 'vrm' }
    });
    const res = await request(app)
      .post('/data')
      .send({ importPrice: { start: '2024-02-01T00:00:00Z', step: 60, values: [99] } });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('No valid data keys provided or settings are not set to API');
    expect(saveData).not.toHaveBeenCalled();
  });

  it('POST /data should validate structure', async () => {
    // Missing values
    const res1 = await request(app)
      .post('/data')
      .send({ importPrice: { start: '2024-01-01T00:00:00Z' } });
    expect(res1.status).toBe(400);
    expect(res1.body.message).toMatch(/values/);

    // Invalid start date
    const res2 = await request(app)
      .post('/data')
      .send({ importPrice: { start: 'invalid-date', values: [] } });
    expect(res2.status).toBe(400);
    expect(res2.body.message).toMatch(/valid ISO string/);

    // Invalid step
    const res3 = await request(app)
      .post('/data')
      .send({ importPrice: { start: '2024-01-01T00:00:00Z', values: [], step: -1 } });
    expect(res3.status).toBe(400);
    expect(res3.body.message).toMatch(/positive number/);

    expect(saveData).not.toHaveBeenCalled();
  });
});
