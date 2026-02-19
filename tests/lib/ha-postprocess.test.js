import { describe, it, expect } from 'vitest';
import { postprocess, getSensorNames } from '../../lib/ha-postprocess.js';

const sensors = [
  { id: 'sensor.grid_import_1', name: 'Grid Import', unit: 'kWh' },
  { id: 'sensor.grid_import_2', name: 'Grid Import', unit: 'kWh' },
  { id: 'sensor.solar', name: 'Solar', unit: 'Wh' },
];

const derived = [
  { name: 'Net', formula: ['+Grid Import', '-Solar'] },
];

// A timestamp that is a valid HA start value (numeric ms since epoch when converted)
const t1 = new Date('2026-01-01T10:00:00.000Z').getTime();
const t2 = new Date('2026-01-01T11:00:00.000Z').getTime();

const rawData = {
  'sensor.grid_import_1': [{ start: t1, change: 1 }, { start: t2, change: 2 }],
  'sensor.grid_import_2': [{ start: t1, change: 0.5 }, { start: t2, change: 0.5 }],
  'sensor.solar': [{ start: t1, change: 500 }, { start: t2, change: 800 }],
};

describe('postprocess', () => {
  it('converts kWh sensors to Wh', () => {
    const data = postprocess(rawData, sensors, []);
    const gridAt10 = data.find(d => d.sensor === 'Grid Import' && d.hour === 10);
    // 1 kWh + 0.5 kWh = 1.5 kWh = 1500 Wh
    expect(gridAt10?.value).toBeCloseTo(1500);
  });

  it('merges sensors with the same name', () => {
    const data = postprocess(rawData, sensors, []);
    // Only one record per timestamp per sensor name
    const gridRecords = data.filter(d => d.sensor === 'Grid Import' && d.hour === 10);
    expect(gridRecords).toHaveLength(1);
  });

  it('keeps Wh sensors as-is', () => {
    const data = postprocess(rawData, sensors, []);
    const solarAt10 = data.find(d => d.sensor === 'Solar' && d.hour === 10);
    expect(solarAt10?.value).toBe(500);
  });

  it('computes derived series', () => {
    const data = postprocess(rawData, sensors, derived);
    const netAt10 = data.find(d => d.sensor === 'Net' && d.hour === 10);
    // Grid Import 1500 Wh - Solar 500 Wh = 1000 Wh
    expect(netAt10?.value).toBeCloseTo(1000);
  });

  it('populates date, hour, dayOfWeek fields', () => {
    const data = postprocess(rawData, sensors, []);
    const rec = data.find(d => d.hour === 10 && d.sensor === 'Solar');
    expect(rec).toBeDefined();
    expect(rec.date).toBe('2026-01-01T10:00:00.000Z');
    expect(rec.hour).toBe(10);
    expect(typeof rec.dayOfWeek).toBe('number');
  });

  it('handles empty rawData', () => {
    const data = postprocess({}, sensors, derived);
    expect(data).toEqual([]);
  });
});

describe('getSensorNames', () => {
  it('returns unique sensor names', () => {
    const data = postprocess(rawData, sensors, derived);
    const names = getSensorNames(data);
    expect(names).toContain('Grid Import');
    expect(names).toContain('Solar');
    expect(names).toContain('Net');
    // No duplicates
    expect(names.length).toBe(new Set(names).size);
  });
});
