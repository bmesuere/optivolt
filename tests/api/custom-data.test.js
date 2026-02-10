import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import bodyParser from 'body-parser';
import { loadData, saveData } from '../../api/services/data-store.js';
import { loadSettings, saveSettings } from '../../api/services/settings-store.js';
import dataRouter from '../../api/routes/data.js';
import calculateRouter from '../../api/routes/calculate.js';
import { refreshSeriesFromVrmAndPersist } from '../../api/services/vrm-refresh.js';

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
app.use(bodyParser.json());
app.use('/data', dataRouter);
app.use('/calculate', calculateRouter);

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
      dataSources: { prices: 'vrm' } // default
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

    expect(res.status).toBe(200); // We return 200 with "No valid data keys provided" message?
    // Actually implementation returns 200 but keysUpdated is empty. Logic check:
    expect(res.body.message).toBe('No valid data keys provided');
    expect(saveData).not.toHaveBeenCalled();
  });

  it('POST /data should validate structure', async () => {
    const res = await request(app)
      .post('/data')
      .send({ importPrice: { start: '...' } }); // Missing values

    // The implementation throws error inside validateSeries -> next(error) -> 400
    expect(res.status).toBe(400);
    expect(saveData).not.toHaveBeenCalled();
  });
});
