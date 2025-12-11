import { describe, it, expect } from 'vitest';
import { parseSolution } from '../../lib/parse-solution.js';

describe('parseSolution', () => {
  const cfg = {
    load_W: [500, 600],
    pv_W: [100, 0],
    importPrice: [10, 20],
    exportPrice: [5, 5],
    batteryCapacity_Wh: 1000,
  };

  const opts = {
    startMs: 1700000000000,
    stepMin: 60,
  };

  it('correctly parses HiGHS columns into rows', () => {
    // Mock result from HiGHS
    const result = {
      Columns: [
        { Name: 'grid_to_load_0', Primal: 400 },
        { Name: 'pv_to_load_0', Primal: 100 },
        { Name: 'grid_to_load_1', Primal: 600 },
        { Name: 'soc_0', Primal: 200 },
        { Name: 'soc_1', Primal: 200 },
      ],
    };

    const rows = parseSolution(result, cfg, opts);

    expect(rows).toHaveLength(2);
    expect(rows[0].g2l).toBe(400);
    expect(rows[0].pv2l).toBe(100);
    expect(rows[1].g2l).toBe(600);
    expect(rows[0].soc).toBe(200);
    expect(rows[0].soc_percent).toBe(20);
    expect(rows[0].timestampMs).toBe(1700000000000);
    expect(rows[1].timestampMs).toBe(1700000000000 + 3600000);
  });

  it('handles object-based column format (newer HiGHS versions or defaults)', () => {
    const result = {
        Columns: {
            'grid_to_load_0': { Primal: 400 },
            'pv_to_load_0': { Primal: 100 }
        }
    };
     const rows = parseSolution(result, cfg, opts);
     expect(rows[0].g2l).toBe(400);
     expect(rows[0].pv2l).toBe(100);
  });

  it('throws if timing options are missing', () => {
    expect(() => parseSolution({}, cfg, {})).toThrow('Missing');
  });
});
