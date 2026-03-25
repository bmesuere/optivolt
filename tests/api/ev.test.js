import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import app from '../../api/app.ts';

vi.mock('../../api/services/planner-service.ts');

import { getLastPlan } from '../../api/services/planner-service.ts';

const START_MS = 1700000000000;

const makeRow = (timestampMs, charge) => ({
  timestampMs,
  ev_charge: charge,
  ev_charge_A: charge / 230,
  ev_charge_mode: charge > 0 ? 'fixed' : 'off',
  g2ev: charge,
  pv2ev: 0,
  b2ev: 0,
  ev_soc_percent: 55,
});

const mockPlan = {
  timing: { startMs: START_MS, stepMin: 15 },
  rows: [
    makeRow(START_MS,              1380),
    makeRow(START_MS + 900_000,    1380),
    makeRow(START_MS + 1_800_000,  0),
  ],
  summary: {
    evChargeTotal_kWh:       0.207,
    evChargeFromGrid_kWh:    0.207,
    evChargeFromPv_kWh:      0,
    evChargeFromBattery_kWh: 0,
  },
};

describe('GET /ev/schedule', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns 404 when no plan has been computed', async () => {
    getLastPlan.mockReturnValue(null);
    const res = await request(app).get('/ev/schedule');
    expect(res.status).toBe(404);
  });

  it('returns planStart, slots, and summary when a plan exists', async () => {
    getLastPlan.mockReturnValue(mockPlan);
    const res = await request(app).get('/ev/schedule');

    expect(res.status).toBe(200);
    expect(res.body.planStart).toBe(new Date(START_MS).toISOString());
    expect(res.body.slots).toHaveLength(3);
    expect(res.body.slots[0]).toMatchObject({
      timestampMs:    START_MS,
      ev_charge_W:    1380,
      ev_charge_mode: 'fixed',
      g2ev_W:         1380,
    });
    expect(res.body.summary.evChargeTotal_kWh).toBe(0.207);
    expect(res.body.summary.evChargeFromGrid_kWh).toBe(0.207);
  });

  it('includes ev_soc_percent in each slot', async () => {
    getLastPlan.mockReturnValue(mockPlan);
    const res = await request(app).get('/ev/schedule');
    expect(res.body.slots[0].ev_soc_percent).toBe(55);
  });
});

describe('GET /ev/current', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => vi.useRealTimers());

  it('returns 404 when no plan has been computed', async () => {
    getLastPlan.mockReturnValue(null);
    const res = await request(app).get('/ev/current');
    expect(res.status).toBe(404);
  });

  it('returns current slot data with is_charging flag', async () => {
    getLastPlan.mockReturnValue(mockPlan);
    vi.setSystemTime(START_MS + 500_000); // within slot 0

    const res = await request(app).get('/ev/current');

    expect(res.status).toBe(200);
    expect(res.body.timestampMs).toBe(START_MS);
    expect(res.body.ev_charge_W).toBe(1380);
    expect(res.body.is_charging).toBe(true);
  });

  it('selects the most recent past slot', async () => {
    getLastPlan.mockReturnValue(mockPlan);
    vi.setSystemTime(START_MS + 1_900_000); // past slot 2

    const res = await request(app).get('/ev/current');

    expect(res.body.timestampMs).toBe(START_MS + 1_800_000);
    expect(res.body.is_charging).toBe(false);
  });

  it('falls back to rows[0] when all timestamps are in the future', async () => {
    getLastPlan.mockReturnValue(mockPlan);
    vi.setSystemTime(START_MS - 10_000); // before all slots

    const res = await request(app).get('/ev/current');

    expect(res.body.timestampMs).toBe(START_MS);
  });
});
