import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import app from '../../api/app.ts';

vi.mock('../../api/services/planner-service.ts');
vi.mock('../../api/services/data-store.ts');

import { getLastPlan } from '../../api/services/planner-service.ts';
import { loadData, saveData } from '../../api/services/data-store.ts';

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

describe('/ev/schedule-entries CRUD', () => {
  const FAR_FUTURE = '2100-01-01T06:00:00Z';
  const FAR_PAST = '2000-01-01T06:00:00Z';
  const makeEntry = (over = {}) => ({
    id: 'e1', type: 'departure', time: FAR_FUTURE,
    createdAt: FAR_PAST, updatedAt: FAR_PAST, ...over,
  });

  beforeEach(() => {
    vi.resetAllMocks();
    saveData.mockResolvedValue();
  });

  it('creates an entry and persists it', async () => {
    loadData.mockResolvedValue({ evScheduleEntries: [] });
    const res = await request(app)
      .post('/ev/schedule-entries')
      .send({ type: 'departure', time: FAR_FUTURE, soc_percent: 80 });

    expect(res.status).toBe(201);
    expect(res.body.entry).toMatchObject({ type: 'departure', soc_percent: 80 });
    expect(res.body.entries).toHaveLength(1);
    expect(saveData).toHaveBeenCalledWith(expect.objectContaining({
      evScheduleEntries: expect.arrayContaining([expect.objectContaining({ type: 'departure' })]),
    }));
  });

  it('rejects an invalid entry (target without SoC)', async () => {
    loadData.mockResolvedValue({ evScheduleEntries: [] });
    const res = await request(app)
      .post('/ev/schedule-entries')
      .send({ type: 'target', time: FAR_FUTURE });
    expect(res.status).toBe(400);
  });

  it('prunes past entries on GET', async () => {
    loadData.mockResolvedValue({
      evScheduleEntries: [makeEntry({ id: 'past', time: FAR_PAST }), makeEntry({ id: 'future' })],
    });
    const res = await request(app).get('/ev/schedule-entries');
    expect(res.status).toBe(200);
    expect(res.body.entries.map(e => e.id)).toEqual(['future']);
    expect(saveData).toHaveBeenCalled();
  });

  it('updates an entry', async () => {
    loadData.mockResolvedValue({ evScheduleEntries: [makeEntry({ soc_percent: 80 })] });
    const res = await request(app)
      .patch('/ev/schedule-entries/e1')
      .send({ soc_percent: 55 });
    expect(res.status).toBe(200);
    expect(res.body.entry.soc_percent).toBe(55);
  });

  it('deletes an entry', async () => {
    loadData.mockResolvedValue({ evScheduleEntries: [makeEntry()] });
    const res = await request(app).delete('/ev/schedule-entries/e1');
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
  });

  it('returns 404 for an unknown id on update and delete', async () => {
    loadData.mockResolvedValue({ evScheduleEntries: [makeEntry()] });
    expect((await request(app).patch('/ev/schedule-entries/nope').send({ soc_percent: 10 })).status).toBe(404);
    expect((await request(app).delete('/ev/schedule-entries/nope')).status).toBe(404);
  });
});
