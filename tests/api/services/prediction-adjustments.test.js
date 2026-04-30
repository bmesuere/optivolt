import { describe, expect, it } from 'vitest';
import {
  applyPredictionAdjustmentsToData,
  applyPredictionAdjustmentsToSeries,
  pruneExpiredPredictionAdjustments,
} from '../../../api/services/prediction-adjustments.ts';

const series = {
  start: '2026-01-01T00:00:00.000Z',
  step: 15,
  values: [100, 200, 300, 400, 500],
};

function adjustment(overrides = {}) {
  return {
    id: 'adj-1',
    series: 'load',
    mode: 'add',
    value_W: 50,
    start: '2026-01-01T00:15:00.000Z',
    end: '2026-01-01T00:45:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('prediction adjustments', () => {
  it('adds watts across the half-open selected range', () => {
    const adjusted = applyPredictionAdjustmentsToSeries(series, [adjustment()], 'load');
    expect(adjusted.values).toEqual([100, 250, 350, 400, 500]);
  });

  it('sets PV to zero across the selected range', () => {
    const adjusted = applyPredictionAdjustmentsToSeries(series, [
      adjustment({ series: 'pv', mode: 'set', value_W: 0, start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T00:30:00.000Z' }),
    ], 'pv');
    expect(adjusted.values).toEqual([0, 0, 300, 400, 500]);
  });

  it('uses the latest set adjustment as the baseline and stacks add adjustments', () => {
    const adjusted = applyPredictionAdjustmentsToSeries(series, [
      adjustment({ id: 'set-1', mode: 'set', value_W: 900, start: '2026-01-01T00:15:00.000Z', end: '2026-01-01T01:00:00.000Z' }),
      adjustment({ id: 'set-2', mode: 'set', value_W: 700, start: '2026-01-01T00:30:00.000Z', end: '2026-01-01T00:45:00.000Z' }),
      adjustment({ id: 'add-1', mode: 'add', value_W: 25, start: '2026-01-01T00:30:00.000Z', end: '2026-01-01T00:45:00.000Z' }),
    ], 'load');
    expect(adjusted.values).toEqual([100, 900, 725, 900, 500]);
  });

  it('clamps negative adjusted values to zero', () => {
    const adjusted = applyPredictionAdjustmentsToSeries(series, [
      adjustment({ mode: 'add', value_W: -500, start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T00:30:00.000Z' }),
    ], 'load');
    expect(adjusted.values).toEqual([0, 0, 300, 400, 500]);
  });

  it('applies load and PV adjustments independently to data', () => {
    const data = {
      load: series,
      pv: series,
      importPrice: series,
      exportPrice: series,
      soc: { timestamp: '2026-01-01T00:00:00.000Z', value: 50 },
      predictionAdjustments: [
        adjustment({ series: 'load', mode: 'add', value_W: 100 }),
        adjustment({ series: 'pv', mode: 'set', value_W: 0 }),
      ],
    };
    const adjusted = applyPredictionAdjustmentsToData(data);
    expect(adjusted.load.values).toEqual([100, 300, 400, 400, 500]);
    expect(adjusted.pv.values).toEqual([100, 0, 0, 400, 500]);
  });

  it('prunes expired adjustments', () => {
    const data = {
      load: series,
      pv: series,
      importPrice: series,
      exportPrice: series,
      soc: { timestamp: '2026-01-01T00:00:00.000Z', value: 50 },
      predictionAdjustments: [
        adjustment({ id: 'old', end: '2026-01-01T00:15:00.000Z' }),
        adjustment({ id: 'active', end: '2026-01-01T01:00:00.000Z' }),
      ],
    };
    const result = pruneExpiredPredictionAdjustments(data, new Date('2026-01-01T00:30:00.000Z').getTime());
    expect(result.changed).toBe(true);
    expect(result.adjustments.map(adj => adj.id)).toEqual(['active']);
  });
});
