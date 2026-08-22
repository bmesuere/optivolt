import { describe, it, expect } from 'vitest';
import {
  computeDayMeanTemps,
  computeEffectiveDayTemps,
  buildTemperatureAnchors,
  predictHourFromAnchors,
  predictTemperatureLoad,
  predictTemperatureLoadRolling,
  dayKey,
} from '../../lib/load-predictor-temperature.ts';

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Hourly TemperatureRecords for one UTC day. */
function tempsForDay(dayIso, temp_C) {
  const start = new Date(dayIso + 'T00:00:00Z').getTime();
  return Array.from({ length: 24 }, (_, h) => ({ time: start + h * HOUR_MS, temp_C }));
}

/** Hourly StatRecords for one UTC day with value = profile(hour). */
function loadForDay(dayIso, sensor, profile) {
  const start = new Date(dayIso + 'T00:00:00Z').getTime();
  return Array.from({ length: 24 }, (_, h) => {
    const time = start + h * HOUR_MS;
    const d = new Date(time);
    return {
      date: d.toISOString(),
      time,
      hour: h,
      dayOfWeek: d.getUTCDay(),
      sensor,
      value: profile(h),
    };
  });
}

/** N consecutive UTC days ending the day before `endExclusiveIso`. */
function dayRange(endExclusiveIso, n) {
  const end = new Date(endExclusiveIso + 'T00:00:00Z').getTime();
  return Array.from({ length: n }, (_, i) => dayKey(end - (n - i) * DAY_MS));
}

describe('computeDayMeanTemps / computeEffectiveDayTemps', () => {
  it('averages hourly temps per UTC day', () => {
    const temps = [
      ...tempsForDay('2026-01-10', 4),
      ...tempsForDay('2026-01-11', 8),
    ];
    const means = computeDayMeanTemps(temps);
    expect(means.get('2026-01-10')).toBe(4);
    expect(means.get('2026-01-11')).toBe(8);
  });

  it('blends 4:2:1 over today, yesterday, and the day before', () => {
    const temps = [
      ...tempsForDay('2026-01-10', 0),
      ...tempsForDay('2026-01-11', 7),
      ...tempsForDay('2026-01-12', 14),
    ];
    const eff = computeEffectiveDayTemps(computeDayMeanTemps(temps));
    // (4*14 + 2*7 + 1*0) / 7 = 10
    expect(eff.get('2026-01-12')).toBeCloseTo(10, 10);
  });

  it('renormalizes when earlier days are missing', () => {
    const eff = computeEffectiveDayTemps(new Map([['2026-01-10', 6]]));
    expect(eff.get('2026-01-10')).toBe(6);
  });
});

describe('buildTemperatureAnchors', () => {
  // 16 days ending 2026-03-31 (now = 2026-04-01): first 8 cold (2 °C, high
  // load), last 8 warm (14 °C, low load). All within a 4-week lookback.
  const nowMs = new Date('2026-04-01T10:00:00Z').getTime();
  const days = dayRange('2026-04-01', 16);
  const coldProfile = h => (h >= 6 && h < 22 ? 1200 : 50);
  const warmProfile = h => (h >= 6 && h < 22 ? 200 : 50);

  function makeInputs() {
    const data = [];
    const temps = [];
    days.forEach((day, i) => {
      const cold = i < 8;
      data.push(...loadForDay(day, 'Heat Pump', cold ? coldProfile : warmProfile));
      temps.push(...tempsForDay(day, cold ? 2 : 14));
    });
    return { data, effTemps: computeEffectiveDayTemps(computeDayMeanTemps(temps)) };
  }

  const cfg = { sensor: 'Heat Pump', lookbackWeeks: 4, dayFilter: 'all', bins: 2 };

  it('builds temperature-sorted anchors with median profiles', () => {
    const { data, effTemps } = makeInputs();
    const model = buildTemperatureAnchors(data, effTemps, cfg, nowMs);

    const anchors = model.buckets.get('all');
    expect(anchors).toHaveLength(2);
    expect(anchors[0].temp_C).toBeLessThan(anchors[1].temp_C);
    expect(anchors[0].profile[12]).toBe(1200);
    expect(anchors[1].profile[12]).toBe(200);
    expect(anchors[0].profile[2]).toBe(50);
    expect(anchors[1].profile[2]).toBe(50);
  });

  it('excludes today and days outside the lookback window', () => {
    const { data, effTemps } = makeInputs();
    const withToday = [...data, ...loadForDay('2026-04-01', 'Heat Pump', () => 99999)];
    const model = buildTemperatureAnchors(withToday, effTemps, { ...cfg, lookbackWeeks: 1 }, nowMs);

    // Only ~6 full days fit in a 1-week lookback → a single anchor, and
    // today's absurd values must not appear in it.
    const anchors = model.buckets.get('all');
    expect(anchors).toHaveLength(1);
    expect(anchors[0].profile[12]).toBe(200);
  });

  it('drops days with too few hourly readings', () => {
    const { data, effTemps } = makeInputs();
    const partial = loadForDay(dayKey(new Date('2026-04-01T00:00:00Z').getTime() - 17 * DAY_MS), 'Heat Pump', () => 5000).slice(0, 10);
    const model = buildTemperatureAnchors([...data, ...partial], effTemps, cfg, nowMs);
    for (const anchor of model.buckets.get('all')) {
      expect(anchor.profile[5]).not.toBe(5000);
    }
  });

  it('keeps weekday and weekend buckets separate and provides pooled anchors', () => {
    const { data, effTemps } = makeInputs();
    const model = buildTemperatureAnchors(data, effTemps, { ...cfg, dayFilter: 'weekday-weekend' }, nowMs);
    expect([...model.buckets.keys()].sort()).toEqual(['weekday', 'weekend']);
    expect(model.pooled.length).toBeGreaterThan(0);
  });
});

describe('predictHourFromAnchors', () => {
  const anchors = [
    { temp_C: 2, profile: Array(24).fill(1000), dayCount: 5 },
    { temp_C: 12, profile: Array(24).fill(200), dayCount: 5 },
  ];

  it('interpolates linearly between bracketing anchors', () => {
    expect(predictHourFromAnchors(anchors, 7, 10)).toBeCloseTo(600, 10);
  });

  it('extrapolates along the outermost segment for colder temperatures', () => {
    // slope = -80 W/°C; at -1 °C → 1000 + 3*80 = 1240
    expect(predictHourFromAnchors(anchors, -1, 10)).toBeCloseTo(1240, 10);
  });

  it('clamps extrapolation to half the anchor span', () => {
    // span 10 °C → clamp at 2 - 5 = -3 °C → 1000 + 5*80 = 1400, even at -30 °C
    expect(predictHourFromAnchors(anchors, -30, 10)).toBeCloseTo(1400, 10);
  });

  it('floors extrapolation at the lowest anchor value, not 0', () => {
    // At 30 °C the line would run to -200, but the mildest anchor's 200 W
    // is the device's idle draw — the prediction flattens out there.
    expect(predictHourFromAnchors(anchors, 30, 10)).toBe(200);
  });

  it('takes the floor over all hours, not just the predicted hour', () => {
    const profile = Array(24).fill(200);
    profile[3] = 50; // idle draw shows at hour 3; the floor applies everywhere
    const withNightIdle = [
      { temp_C: 2, profile: Array(24).fill(1000), dayCount: 5 },
      { temp_C: 12, profile, dayCount: 5 },
    ];
    expect(predictHourFromAnchors(withNightIdle, 30, 10)).toBe(50);
  });

  it('still floors at 0 when the lowest anchor value is 0', () => {
    const withIdleOff = [
      { temp_C: 2, profile: Array(24).fill(1000), dayCount: 5 },
      { temp_C: 12, profile: Array(24).fill(0), dayCount: 5 },
    ];
    expect(predictHourFromAnchors(withIdleOff, 30, 10)).toBe(0);
  });

  it('returns the profile as-is for a single anchor', () => {
    expect(predictHourFromAnchors([anchors[0]], -5, 3)).toBe(1000);
  });

  it('averages instead of dividing when anchor temps nearly coincide', () => {
    const flat = [
      { temp_C: 10, profile: Array(24).fill(100), dayCount: 4 },
      { temp_C: 10.2, profile: Array(24).fill(300), dayCount: 4 },
    ];
    expect(predictHourFromAnchors(flat, 10.1, 0)).toBe(200);
  });

  it('returns null when no anchors exist or the hour is unobserved', () => {
    expect(predictHourFromAnchors([], 5, 0)).toBeNull();
    const gappy = [
      { temp_C: 2, profile: Array(24).fill(null), dayCount: 4 },
      { temp_C: 12, profile: Array(24).fill(null), dayCount: 4 },
    ];
    expect(predictHourFromAnchors(gappy, 5, 0)).toBeNull();
  });
});

describe('predictTemperatureLoad', () => {
  it('predicts targets from the matching bucket and reports actuals', () => {
    const model = {
      buckets: new Map([['all', [
        { temp_C: 2, profile: Array(24).fill(1000), dayCount: 5 },
        { temp_C: 12, profile: Array(24).fill(200), dayCount: 5 },
      ]]]),
      pooled: [],
    };
    const time = new Date('2026-04-02T10:00:00Z').getTime();
    const effTemps = new Map([['2026-04-02', 7]]);
    const targets = [{ date: new Date(time).toISOString(), time, hour: 10, dayOfWeek: 4, value: 550 }];

    const [result] = predictTemperatureLoad(model, 'all', targets, effTemps);
    expect(result.predicted).toBeCloseTo(600, 10);
    expect(result.actual).toBe(550);
  });

  it('returns null predictions for days without a temperature', () => {
    const model = { buckets: new Map(), pooled: [] };
    const time = new Date('2026-04-02T10:00:00Z').getTime();
    const targets = [{ date: new Date(time).toISOString(), time, hour: 10, dayOfWeek: 4, value: null }];

    const [result] = predictTemperatureLoad(model, 'all', targets, new Map());
    expect(result.predicted).toBeNull();
  });
});

describe('predictTemperatureLoadRolling', () => {
  it('predicts each day from only the history before it', () => {
    // 100 W through 2026-04-03, 500 W from 2026-04-04 on, constant temp.
    const cfg = { sensor: 'Heat Pump', lookbackWeeks: 1, dayFilter: 'all', bins: 4 };
    const days = dayRange('2026-04-10', 12); // 2026-03-29 .. 2026-04-09
    const data = days.flatMap(day =>
      loadForDay(day, 'Heat Pump', () => (day < '2026-04-04' ? 100 : 500)));
    const effTemps = new Map(days.map(day => [day, 10]));

    const targetFor = day => data.find(d => dayKey(d.time) === day && d.hour === 12);
    const results = predictTemperatureLoadRolling(
      data, cfg, [targetFor('2026-04-04'), targetFor('2026-04-09')], effTemps);

    // The first 500 W day is predicted from 100 W days only — its own values
    // never feed its anchors — while five days later the rolling lookback
    // has caught up with the new level.
    expect(results[0].predicted).toBe(100);
    expect(results[0].actual).toBe(500);
    expect(results[1].predicted).toBe(500);
  });
});
