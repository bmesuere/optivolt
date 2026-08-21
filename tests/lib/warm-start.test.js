import { describe, it, expect } from 'vitest';
import { buildWarmStartColumns } from '../../lib/warm-start.ts';

const STEP_MIN = 15;
const STEP_MS = STEP_MIN * 60_000;

function input(columns, deltaSlots = 0) {
  return { columns, prevStartMs: 1_000_000, nextStartMs: 1_000_000 + deltaSlots * STEP_MS, stepMin: STEP_MIN };
}

describe('buildWarmStartColumns', () => {
  it('passes only the binary skeleton, not continuous flows', () => {
    const warm = buildWarmStartColumns(input({
      ev_on_3: { Primal: 1 },
      start_balance_5: { Primal: 1 },
      grid_to_load_3: { Primal: 500 },
      soc_3: { Primal: 12000 },
      battery_to_grid_3: { Primal: 1000 },
    }));
    expect(warm).toEqual({ ev_on_3: 1, start_balance_5: 1 });
  });

  it('shifts slot indices by the elapsed slots and drops scrolled-out slots', () => {
    const warm = buildWarmStartColumns(input({
      ev_on_1: { Primal: 1 },
      ev_on_2: { Primal: 0 },
      ev_on_3: { Primal: 1 },
      start_balance_2: { Primal: 1 },
    }, 2));
    expect(warm).toEqual({ ev_on_1: 1, start_balance_0: 1, ev_on_0: 0 });
  });

  it('rounds integrality slop to exact 0/1', () => {
    const warm = buildWarmStartColumns(input({
      ev_on_0: { Primal: 0.9999997 },
      ev_on_1: { Primal: 2.1e-7 },
      ev_on_2: {},
    }));
    expect(warm).toEqual({ ev_on_0: 1, ev_on_1: 0, ev_on_2: 0 });
  });

  it('returns undefined when the shift is not a whole number of slots', () => {
    const warm = buildWarmStartColumns({
      columns: { ev_on_0: { Primal: 1 } },
      prevStartMs: 0,
      nextStartMs: STEP_MS / 2,
      stepMin: STEP_MIN,
    });
    expect(warm).toBeUndefined();
  });

  it('returns undefined when the clock went backwards', () => {
    const warm = buildWarmStartColumns({
      columns: { ev_on_0: { Primal: 1 } },
      prevStartMs: STEP_MS,
      nextStartMs: 0,
      stepMin: STEP_MIN,
    });
    expect(warm).toBeUndefined();
  });

  it('returns undefined when no binary survives the shift', () => {
    const warm = buildWarmStartColumns(input({
      ev_on_0: { Primal: 1 },
      grid_to_load_5: { Primal: 100 },
    }, 3));
    expect(warm).toBeUndefined();
  });

  it('returns undefined for a plan with no binaries at all', () => {
    const warm = buildWarmStartColumns(input({ grid_to_load_0: { Primal: 100 }, soc_0: { Primal: 5000 } }));
    expect(warm).toBeUndefined();
  });

  it('does not confuse overlapping variable-name prefixes', () => {
    // soc_shortfall_2 must not be parsed as a binary family member
    const warm = buildWarmStartColumns(input({
      soc_shortfall_2: { Primal: 1 },
      ev_soc_2: { Primal: 40000 },
      ev_on_2: { Primal: 1 },
    }));
    expect(warm).toEqual({ ev_on_2: 1 });
  });
});
