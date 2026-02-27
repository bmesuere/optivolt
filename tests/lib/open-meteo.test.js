import { describe, it, expect } from 'vitest';
import {
  buildArchiveUrl,
  buildForecastUrl,
  parseIrradianceResponse,
  parseMinutely15Response,
  parseForecastResponse,
} from '../../lib/open-meteo.ts';

// ---------------------------------------------------------------------------
// buildArchiveUrl
// ---------------------------------------------------------------------------

describe('buildArchiveUrl', () => {
  it('builds correct URL with parameters', () => {
    const url = buildArchiveUrl({
      latitude: 51.05,
      longitude: 3.71,
      startDate: '2024-06-01',
      endDate: '2024-06-14',
    });

    expect(url).toContain('archive-api.open-meteo.com');
    expect(url).toContain('latitude=51.05');
    expect(url).toContain('longitude=3.71');
    expect(url).toContain('start_date=2024-06-01');
    expect(url).toContain('end_date=2024-06-14');
    expect(url).toContain('hourly=shortwave_radiation');
    expect(url).toContain('timezone=GMT');
  });
});

// ---------------------------------------------------------------------------
// buildForecastUrl
// ---------------------------------------------------------------------------

describe('buildForecastUrl', () => {
  it('builds correct URL with defaults', () => {
    const url = buildForecastUrl({ latitude: 51.05, longitude: 3.71 });

    expect(url).toContain('api.open-meteo.com/v1/forecast');
    expect(url).toContain('latitude=51.05');
    expect(url).toContain('longitude=3.71');
    expect(url).toContain('models=icon_d2');
    expect(url).toContain('timezone=GMT');
    expect(url).toContain('past_days=1');
    expect(url).toContain('forecast_days=2');
    expect(url).toContain('hourly=shortwave_radiation');
  });

  it('allows custom model and days', () => {
    const url = buildForecastUrl({
      latitude: 0,
      longitude: 0,
      model: 'gfs_seamless',
      pastDays: 3,
      forecastDays: 5,
    });

    expect(url).toContain('models=gfs_seamless');
    expect(url).toContain('past_days=3');
    expect(url).toContain('forecast_days=5');
  });

  it('uses hourly param when resolution=60', () => {
    const url = buildForecastUrl({ latitude: 51.05, longitude: 3.71, resolution: 60 });
    expect(url).toContain('hourly=shortwave_radiation');
    expect(url).not.toContain('minutely_15');
  });

  it('uses minutely_15 param when resolution=15', () => {
    const url = buildForecastUrl({ latitude: 51.05, longitude: 3.71, resolution: 15 });
    expect(url).toContain('minutely_15=shortwave_radiation');
    expect(url).not.toContain('hourly=');
  });
});

// ---------------------------------------------------------------------------
// parseIrradianceResponse
// ---------------------------------------------------------------------------

describe('parseIrradianceResponse', () => {
  it('parses response and applies backward-averaging alignment', () => {
    // Open-Meteo hour 14:00 UTC = interval 13:00–14:00 → intervalStartHour = 13
    const data = {
      hourly: {
        time: ['2024-06-15T14:00'],
        shortwave_radiation: [600],
      },
    };

    const records = parseIrradianceResponse(data);
    expect(records).toHaveLength(1);
    expect(records[0].hour).toBe(13);
    expect(records[0].ghi_W_per_m2).toBe(600);
    expect(records[0].intervalMinutes).toBe(60);

    // Timestamp should be shifted back 1 hour
    const expectedTime = new Date('2024-06-15T13:00:00Z').getTime();
    expect(records[0].time).toBe(expectedTime);
  });

  it('wraps hour 0 backward to hour 23', () => {
    const data = {
      hourly: {
        time: ['2024-06-15T00:00'],
        shortwave_radiation: [0],
      },
    };

    const records = parseIrradianceResponse(data);
    expect(records[0].hour).toBe(23);
  });

  it('treats null radiation as 0', () => {
    const data = {
      hourly: {
        time: ['2024-06-15T12:00'],
        shortwave_radiation: [null],
      },
    };

    const records = parseIrradianceResponse(data);
    expect(records[0].ghi_W_per_m2).toBe(0);
  });

  it('clamps negative radiation to 0', () => {
    const data = {
      hourly: {
        time: ['2024-06-15T12:00'],
        shortwave_radiation: [-5],
      },
    };

    const records = parseIrradianceResponse(data);
    expect(records[0].ghi_W_per_m2).toBe(0);
  });

  it('handles multiple records', () => {
    const data = {
      hourly: {
        time: [
          '2024-06-15T10:00',
          '2024-06-15T11:00',
          '2024-06-15T12:00',
        ],
        shortwave_radiation: [200, 400, 600],
      },
    };

    const records = parseIrradianceResponse(data);
    expect(records).toHaveLength(3);
    expect(records[0].hour).toBe(9);
    expect(records[1].hour).toBe(10);
    expect(records[2].hour).toBe(11);
    expect(records[0].ghi_W_per_m2).toBe(200);
    expect(records[1].ghi_W_per_m2).toBe(400);
    expect(records[2].ghi_W_per_m2).toBe(600);
    expect(records[0].intervalMinutes).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// parseMinutely15Response
// ---------------------------------------------------------------------------

describe('parseMinutely15Response', () => {
  it('parses response with no backward-averaging shift', () => {
    // Open-Meteo minutely_15 labels at interval start — no shift needed
    const data = {
      minutely_15: {
        time: ['2024-06-15T13:00', '2024-06-15T13:15', '2024-06-15T13:30', '2024-06-15T13:45'],
        shortwave_radiation: [500, 520, 510, 480],
      },
    };

    const records = parseMinutely15Response(data);
    expect(records).toHaveLength(4);

    // No shift: hour 13 remains hour 13
    expect(records[0].hour).toBe(13);
    expect(records[0].time).toBe(new Date('2024-06-15T13:00:00Z').getTime());
    expect(records[0].ghi_W_per_m2).toBe(500);
    expect(records[0].intervalMinutes).toBe(15);

    expect(records[1].time).toBe(new Date('2024-06-15T13:15:00Z').getTime());
    expect(records[1].ghi_W_per_m2).toBe(520);
    expect(records[1].intervalMinutes).toBe(15);
  });

  it('treats null radiation as 0', () => {
    const data = {
      minutely_15: {
        time: ['2024-06-15T02:00'],
        shortwave_radiation: [null],
      },
    };
    const records = parseMinutely15Response(data);
    expect(records[0].ghi_W_per_m2).toBe(0);
  });

  it('clamps negative radiation to 0', () => {
    const data = {
      minutely_15: {
        time: ['2024-06-15T12:00'],
        shortwave_radiation: [-10],
      },
    };
    const records = parseMinutely15Response(data);
    expect(records[0].ghi_W_per_m2).toBe(0);
  });

  it('sets intervalMinutes to 15 on all records', () => {
    const data = {
      minutely_15: {
        time: ['2024-06-15T10:00', '2024-06-15T10:15'],
        shortwave_radiation: [300, 350],
      },
    };
    const records = parseMinutely15Response(data);
    expect(records.every(r => r.intervalMinutes === 15)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseForecastResponse
// ---------------------------------------------------------------------------

describe('parseForecastResponse', () => {
  it('dispatches to parseIrradianceResponse when resolution=60', () => {
    const data = {
      hourly: {
        time: ['2024-06-15T14:00'],
        shortwave_radiation: [600],
      },
    };
    const records = parseForecastResponse(data, 60);
    expect(records[0].intervalMinutes).toBe(60);
    expect(records[0].hour).toBe(13); // backward-averaging shift applied
  });

  it('dispatches to parseMinutely15Response when resolution=15', () => {
    const data = {
      minutely_15: {
        time: ['2024-06-15T13:00'],
        shortwave_radiation: [500],
      },
    };
    const records = parseForecastResponse(data, 15);
    expect(records[0].intervalMinutes).toBe(15);
    expect(records[0].hour).toBe(13); // no shift
  });
});
