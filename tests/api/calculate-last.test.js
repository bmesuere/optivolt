import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import app from '../../api/app.ts';

// Mock dependencies
vi.mock('../../api/services/settings-store.ts');
vi.mock('../../api/services/data-store.ts');
vi.mock('../../api/services/vrm-refresh.ts');
vi.mock('../../api/services/mqtt-service.ts');

import { loadSettings } from '../../api/services/settings-store.ts';
import { loadData } from '../../api/services/data-store.ts';
import { bumpSolverInputsVersion } from '../../api/services/solver-inputs-version.ts';

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
  }
};

// These tests share the planner's module-level plan cache, so their order is
// load-bearing: the "no plan yet" case has to run before anything solves.
describe('Integration: GET /calculate/last', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));

    vi.resetAllMocks();
    loadSettings.mockResolvedValue({ ...mockSettings });
    loadData.mockResolvedValue({ ...mockData });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 404 before any plan has been computed', async () => {
    const res = await request(app).get('/calculate/last');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No current plan available');
  });

  it('returns the cached plan with the same shape as POST /calculate', async () => {
    const solved = await request(app).post('/calculate').send({});
    expect(solved.status).toBe(200);

    const res = await request(app).get('/calculate/last');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...solved.body, inputsCurrent: true });
    expect(res.body.rows).toHaveLength(5);
    expect(res.body.solverStatus).toBe('Optimal');
    // Clients gate their fallback recompute on this.
    expect(res.body.computedAtMs).toBe(Date.now());
  });

  it('flags the plan as inputsCurrent: false once solver inputs mutate', async () => {
    await request(app).post('/calculate').send({});
    expect((await request(app).get('/calculate/last')).body.inputsCurrent).toBe(true);

    // The stores are mocked here, so simulate what a real saveData/saveSettings
    // with changed content does.
    bumpSolverInputsVersion();

    const res = await request(app).get('/calculate/last');
    expect(res.status).toBe(200);
    expect(res.body.inputsCurrent).toBe(false);
  });

  it('refuses to serve a non-optimal cached solve', async () => {
    // Battery pinned at min SoC, no PV, and a zero import cap: the load is
    // unservable, so the solve comes back infeasible.
    loadData.mockResolvedValue({ ...mockData, soc: { ...mockData.soc } });
    loadSettings.mockResolvedValue({ ...mockSettings, maxGridImport_W: 0 });

    const solved = await request(app).post('/calculate').send({});
    expect(solved.status).toBe(200);
    expect(solved.body.solverStatus).not.toBe('Optimal');

    const res = await request(app).get('/calculate/last');
    expect(res.status).toBe(404);
  });

  it('returns 404 once the cached plan no longer covers now', async () => {
    await request(app).post('/calculate').send({});

    // Plan spans 00:00–05:00; 04:59 is still inside the last slot.
    vi.setSystemTime(new Date("2024-01-01T04:59:00.000Z"));
    expect((await request(app).get('/calculate/last')).status).toBe(200);

    vi.setSystemTime(new Date("2024-01-01T05:00:00.000Z"));
    expect((await request(app).get('/calculate/last')).status).toBe(404);
  });
});
