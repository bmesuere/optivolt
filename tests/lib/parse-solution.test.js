import { describe, it, expect } from 'vitest';
import { parseSolution } from '../../lib/parse-solution.ts';

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
    const result = {
      Columns: {
        'grid_to_load_0': { Primal: 400 },
        'pv_to_load_0': { Primal: 100 },
        'grid_to_load_1': { Primal: 600 },
        'soc_0': { Primal: 200 },
        'soc_1': { Primal: 200 },
      },
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

});
