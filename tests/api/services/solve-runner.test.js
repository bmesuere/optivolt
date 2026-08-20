import { describe, it, expect } from 'vitest';
import { solveLp } from '../../../api/services/solve-runner.ts';

const TINY_LP = [
  'Minimize',
  ' obj: x',
  'Subject To',
  ' c0: x >= 3',
  'End',
].join('\n');

describe('solveLp — worker-thread solve', () => {
  it('solves a trivial LP on the worker', async () => {
    const result = await solveLp(TINY_LP, { time_limit: 10 });
    expect(result.Status).toBe('Optimal');
    expect(result.Columns.x.Primal).toBe(3);
  });

  it('serializes concurrent solves and resolves both', async () => {
    const [a, b] = await Promise.all([
      solveLp(TINY_LP, { time_limit: 10 }),
      solveLp(TINY_LP.replace('>= 3', '>= 7'), { time_limit: 10 }),
    ]);
    expect(a.Columns.x.Primal).toBe(3);
    expect(b.Columns.x.Primal).toBe(7);
  });

  it('rejects on a malformed LP and recovers on the next call', async () => {
    await expect(solveLp('this is not an LP', { time_limit: 10 })).rejects.toThrow();
    // The failing solve discards the worker; the next call must transparently
    // start a fresh one.
    const result = await solveLp(TINY_LP, { time_limit: 10 });
    expect(result.Status).toBe('Optimal');
  });
});
