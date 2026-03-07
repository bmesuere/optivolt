import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../../api/app.ts';

vi.mock('../../../api/services/planner-service.ts');

import { getLatestEvSchedule, getCurrentEvSlot } from '../../../api/services/planner-service.ts';

const mockSchedule = [
  { timestampMs: 1000, shouldCharge: true, chargePower_W: 1840 },
  { timestampMs: 2000, shouldCharge: false, chargePower_W: 0 },
];

describe('GET /ev/schedule', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns 404 when no plan has been computed', async () => {
    getLatestEvSchedule.mockReturnValue(null);
    const res = await request(app).get('/ev/schedule');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no plan/i);
  });

  it('returns 200 with schedule array', async () => {
    getLatestEvSchedule.mockReturnValue(mockSchedule);
    const res = await request(app).get('/ev/schedule');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].shouldCharge).toBe(true);
    expect(res.body[0].chargePower_W).toBe(1840);
  });
});

describe('GET /ev/current', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns 404 when no plan has been computed', async () => {
    getLatestEvSchedule.mockReturnValue(null);
    const res = await request(app).get('/ev/current');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no plan/i);
  });

  it('returns 200 with current slot', async () => {
    getLatestEvSchedule.mockReturnValue(mockSchedule);
    getCurrentEvSlot.mockReturnValue(mockSchedule[0]);
    const res = await request(app).get('/ev/current');
    expect(res.status).toBe(200);
    expect(res.body.shouldCharge).toBe(true);
    expect(res.body.chargePower_W).toBe(1840);
  });

  it('returns 404 when schedule exists but all slots are in the future', async () => {
    getLatestEvSchedule.mockReturnValue(mockSchedule);
    getCurrentEvSlot.mockReturnValue(null);
    const res = await request(app).get('/ev/current');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/future/i);
  });
});
