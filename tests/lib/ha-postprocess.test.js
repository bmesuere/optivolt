import { describe, it, expect } from 'vitest';
import { postprocess, getSensorNames, aggregateTo15Min } from '../../lib/ha-postprocess.ts';

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

describe('aggregateTo15Min', () => {
  // 13:00, 13:05, 13:10 → bucket 13:00
  const t13_00 = new Date('2026-06-01T13:00:00.000Z').getTime();
  const t13_05 = new Date('2026-06-01T13:05:00.000Z').getTime();
  const t13_10 = new Date('2026-06-01T13:10:00.000Z').getTime();
  // 13:15 → bucket 13:15
  const t13_15 = new Date('2026-06-01T13:15:00.000Z').getTime();

  const make5minRecords = (sensor = 'Solar') => [
    { date: '', time: t13_00, hour: 13, dayOfWeek: 0, sensor, value: 100 },
    { date: '', time: t13_05, hour: 13, dayOfWeek: 0, sensor, value: 110 },
    { date: '', time: t13_10, hour: 13, dayOfWeek: 0, sensor, value: 120 },
    { date: '', time: t13_15, hour: 13, dayOfWeek: 0, sensor, value: 130 },
  ];

  it('sums 3 consecutive 5-min records into one 15-min bucket', () => {
    const result = aggregateTo15Min(make5minRecords());
    const bucket13_00 = result.find(r => r.time === t13_00 && r.sensor === 'Solar');
    expect(bucket13_00?.value).toBeCloseTo(330); // 100 + 110 + 120
  });

  it('creates a separate bucket for the next 15-min slot', () => {
    const result = aggregateTo15Min(make5minRecords());
    const bucket13_15 = result.find(r => r.time === t13_15 && r.sensor === 'Solar');
    expect(bucket13_15?.value).toBeCloseTo(130);
  });

  it('aligns timestamps to 15-min boundaries', () => {
    const result = aggregateTo15Min(make5minRecords());
    for (const r of result) {
      expect(r.time % (15 * 60 * 1000)).toBe(0);
    }
  });

  it('sets hour from 15-min bucket timestamp', () => {
    const result = aggregateTo15Min(make5minRecords());
    for (const r of result) {
      expect(r.hour).toBe(new Date(r.time).getUTCHours());
    }
  });

  it('handles multiple sensors independently', () => {
    const records = [
      ...make5minRecords('Solar'),
      ...make5minRecords('Load'),
    ];
    const result = aggregateTo15Min(records);
    const solarBucket = result.find(r => r.time === t13_00 && r.sensor === 'Solar');
    const loadBucket = result.find(r => r.time === t13_00 && r.sensor === 'Load');
    expect(solarBucket?.value).toBeCloseTo(330);
    expect(loadBucket?.value).toBeCloseTo(330);
  });

  it('handles empty input', () => {
    expect(aggregateTo15Min([])).toEqual([]);
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
