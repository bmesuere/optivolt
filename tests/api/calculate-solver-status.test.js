import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../api/app.ts';
import { SolverStatusError } from '../../lib/parse-solution.ts';

vi.mock('../../api/services/planner-service.ts');

import { planAndMaybeWrite } from '../../api/services/planner-service.ts';

describe('POST /calculate — solver status errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps a SolverStatusError to a 502 naming the solver status', async () => {
    planAndMaybeWrite.mockRejectedValue(new SolverStatusError('Infeasible'));

    const res = await request(app).post('/calculate').send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Infeasible/);
  });

  it('keeps mapping other planner failures to a generic 500', async () => {
    planAndMaybeWrite.mockRejectedValue(new Error('boom'));

    const res = await request(app).post('/calculate').send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to calculate plan');
  });
});
