import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../api/services/settings-store.ts', () => ({
  loadSettings: vi.fn(),
}));
vi.mock('../../../api/services/data-store.ts', () => ({
  loadData: vi.fn(),
  saveData: vi.fn(),
}));

import {
  parseFeedTimestamp,
  pointsToSeries,
  parsePriceForecastFeed,
  refreshPriceForecastAndPersist,
} from '../../../api/services/price-forecast-service.ts';
import { loadSettings } from '../../../api/services/settings-store.ts';
import { loadData, saveData } from '../../../api/services/data-store.ts';

describe('parseFeedTimestamp', () => {
  it('parses bare timestamps as Europe/Brussels wall-clock (winter, UTC+1)', () => {
    expect(parseFeedTimestamp('2026-01-15 12:00:00')).toBe(new Date('2026-01-15T11:00:00Z').getTime());
  });

  it('parses bare timestamps as Europe/Brussels wall-clock (summer, UTC+2)', () => {
    expect(parseFeedTimestamp('2026-08-14 12:00:00')).toBe(new Date('2026-08-14T10:00:00Z').getTime());
  });

  it('parses timestamps with an explicit offset or Z directly', () => {
    expect(parseFeedTimestamp('2026-08-14T12:00:00Z')).toBe(new Date('2026-08-14T12:00:00Z').getTime());
    expect(parseFeedTimestamp('2026-08-14T12:00:00+02:00')).toBe(new Date('2026-08-14T10:00:00Z').getTime());
  });

  it('handles the spring-forward DST transition without drifting more than an hour', () => {
    // 2026-03-29 02:30 does not exist in Brussels (clocks jump 02:00 → 03:00).
    const ts = parseFeedTimestamp('2026-03-29 02:30:00');
    const lower = new Date('2026-03-29T00:30:00Z').getTime(); // 02:30 CEST
    const upper = new Date('2026-03-29T01:30:00Z').getTime(); // 02:30 CET
    expect(ts).toBeGreaterThanOrEqual(lower);
    expect(ts).toBeLessThanOrEqual(upper);
  });

  it('returns the earlier occurrence for an ambiguous fall-back wall time', () => {
    // 02:30 on 2026-10-25 exists as 00:30Z (CEST) and 01:30Z (CET).
    expect(parseFeedTimestamp('2026-10-25 02:30:00')).toBe(new Date('2026-10-25T00:30:00Z').getTime());
  });

  it('returns NaN for unparseable input', () => {
    expect(parseFeedTimestamp('not a date')).toBeNaN();
    expect(parseFeedTimestamp(undefined)).toBeNaN();
  });
});

describe('pointsToSeries', () => {
  const point = (iso, price) => ({ time: iso, price });

  it('builds a contiguous 15-min series from feed-ordered points', () => {
    const series = pointsToSeries([
      point('2026-01-15T10:00:00Z', 1),
      point('2026-01-15T10:15:00Z', 2),
      point('2026-01-15T10:30:00Z', 3),
    ]);
    expect(series.start).toBe('2026-01-15T10:00:00.000Z');
    expect(series.step).toBe(15);
    expect(series.values).toEqual([1, 2, 3]);
  });

  it('truncates at an out-of-order timestamp instead of reordering the feed', () => {
    const series = pointsToSeries([
      point('2026-01-15T10:15:00Z', 2),
      point('2026-01-15T10:00:00Z', 1),
      point('2026-01-15T10:30:00Z', 3),
    ]);
    expect(series.start).toBe('2026-01-15T10:15:00.000Z');
    expect(series.values).toEqual([2]);
  });

  it('truncates at null, empty-string, and boolean prices (Number() would coerce them to 0)', () => {
    for (const bad of [null, '', true, '5']) {
      const series = pointsToSeries([
        point('2026-01-15T10:00:00Z', 1),
        point('2026-01-15T10:15:00Z', bad),
        point('2026-01-15T10:30:00Z', 3),
      ]);
      expect(series.values).toEqual([1]);
    }
    // A feed starting with a null price yields no series at all, not a zero price.
    expect(pointsToSeries([point('2026-01-15T10:00:00Z', null)])).toBeNull();
  });

  it('keeps the repeated hour contiguous across the autumn DST transition', () => {
    // Brussels falls back 03:00 CEST → 02:00 CET on 2026-10-25 (01:00 UTC):
    // wall times 02:00–02:45 occur twice; the sequence disambiguates them.
    const walls = [
      '2026-10-25 01:45:00',
      '2026-10-25 02:00:00', '2026-10-25 02:15:00', '2026-10-25 02:30:00', '2026-10-25 02:45:00',
      '2026-10-25 02:00:00', '2026-10-25 02:15:00', '2026-10-25 02:30:00', '2026-10-25 02:45:00',
      '2026-10-25 03:00:00',
    ];
    const series = pointsToSeries(walls.map((w, i) => point(w, i + 1)));
    expect(series.start).toBe('2026-10-24T23:45:00.000Z'); // 01:45 CEST
    expect(series.values).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('truncates at the first gap so missing slots never become fabricated prices', () => {
    const series = pointsToSeries([
      point('2026-01-15T10:00:00Z', 1),
      point('2026-01-15T10:15:00Z', 2),
      point('2026-01-15T11:00:00Z', 9), // gap: 10:30 and 10:45 missing
    ]);
    expect(series.values).toEqual([1, 2]);
  });

  it('truncates at the first non-finite price', () => {
    const series = pointsToSeries([
      point('2026-01-15T10:00:00Z', 1),
      point('2026-01-15T10:15:00Z', 'oops'),
      point('2026-01-15T10:30:00Z', 3),
    ]);
    expect(series.values).toEqual([1]);
  });

  it('returns null when no points parse', () => {
    expect(pointsToSeries([])).toBeNull();
    expect(pointsToSeries([point('garbage', 1)])).toBeNull();
  });
});

describe('parsePriceForecastFeed', () => {
  it('parses consumption and injection series plus known_until', () => {
    const feed = {
      consumption_data: [{ time: '2026-01-15T10:00:00Z', price: 25 }],
      injection_data: [{ time: '2026-01-15T10:00:00Z', price: 8 }],
      known_until: '2026-01-15T23:45:00Z',
    };
    const parsed = parsePriceForecastFeed(feed);
    expect(parsed.importPriceForecast.values).toEqual([25]);
    expect(parsed.exportPriceForecast.values).toEqual([8]);
    expect(parsed.knownUntilMs).toBe(new Date('2026-01-15T23:45:00Z').getTime());
  });

  it('throws when either series is unusable', () => {
    expect(() => parsePriceForecastFeed({ consumption_data: [], injection_data: [] }))
      .toThrowError(/no usable/);
  });
});

describe('refreshPriceForecastAndPersist', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does nothing when the extended horizon is off or no URL is configured', async () => {
    loadSettings.mockResolvedValue({ extendedHorizonDays: 0, priceForecastUrl: 'https://example.com/f.json' });
    await refreshPriceForecastAndPersist();

    loadSettings.mockResolvedValue({ extendedHorizonDays: 3, priceForecastUrl: '' });
    await refreshPriceForecastAndPersist();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(saveData).not.toHaveBeenCalled();
  });

  it('fetches, parses, and persists the forecast series', async () => {
    loadSettings.mockResolvedValue({ extendedHorizonDays: 3, priceForecastUrl: 'https://example.com/forecast.json' });
    loadData.mockResolvedValue({ existing: true });
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        consumption_data: [
          { time: '2026-01-15 11:00:00', price: 25 },
          { time: '2026-01-15 11:15:00', price: 26 },
        ],
        injection_data: [
          { time: '2026-01-15 11:00:00', price: 8 },
          { time: '2026-01-15 11:15:00', price: 9 },
        ],
        known_until: '2026-01-15 23:45:00',
      }),
    });

    await refreshPriceForecastAndPersist();

    expect(global.fetch).toHaveBeenCalledWith('https://example.com/forecast.json', expect.anything());
    expect(saveData).toHaveBeenCalledTimes(1);
    const persisted = saveData.mock.calls[0][0];
    // 11:00 Brussels winter time = 10:00Z
    expect(persisted.importPriceForecast.start).toBe('2026-01-15T10:00:00.000Z');
    expect(persisted.importPriceForecast.values).toEqual([25, 26]);
    expect(persisted.exportPriceForecast.values).toEqual([8, 9]);
    expect(persisted.existing).toBe(true);
  });

  it('throws (and does not persist) when the feed responds with an error status', async () => {
    loadSettings.mockResolvedValue({ extendedHorizonDays: 3, priceForecastUrl: 'https://example.com/forecast.json' });
    global.fetch.mockResolvedValue({ ok: false, status: 503 });

    await expect(refreshPriceForecastAndPersist()).rejects.toThrowError(/503/);
    expect(saveData).not.toHaveBeenCalled();
  });
});
