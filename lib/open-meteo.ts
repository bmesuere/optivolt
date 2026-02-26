/**
 * open-meteo.ts
 *
 * Pure URL builders and response parsers for the Open-Meteo API.
 * No I/O — the actual HTTP calls live in api/services/open-meteo-client.ts.
 */

import type { IrradianceRecord } from './predict-pv.ts';

// ----------------------------- URL Builders --------------------------------

interface ArchiveUrlParams {
  latitude: number;
  longitude: number;
  startDate: string;  // YYYY-MM-DD
  endDate: string;    // YYYY-MM-DD
}

/**
 * Build URL for the Open-Meteo Archive API.
 * Requests hourly shortwave_radiation in UTC (timezone=GMT).
 */
export function buildArchiveUrl({ latitude, longitude, startDate, endDate }: ArchiveUrlParams): string {
  return (
    `https://archive-api.open-meteo.com/v1/archive`
    + `?latitude=${latitude}&longitude=${longitude}`
    + `&start_date=${startDate}&end_date=${endDate}`
    + `&hourly=shortwave_radiation&timezone=GMT`
  );
}

interface ForecastUrlParams {
  latitude: number;
  longitude: number;
  model?: string;
  pastDays?: number;
  forecastDays?: number;
}

/**
 * Build URL for the Open-Meteo Forecast API.
 * Uses the ICON D2 model by default (good European coverage).
 * Requests hourly shortwave_radiation in UTC (timezone=GMT).
 */
export function buildForecastUrl({
  latitude,
  longitude,
  model = 'icon_d2',
  pastDays = 1,
  forecastDays = 2,
}: ForecastUrlParams): string {
  return (
    `https://api.open-meteo.com/v1/forecast`
    + `?latitude=${latitude}&longitude=${longitude}`
    + `&hourly=shortwave_radiation`
    + `&models=${model}`
    + `&timezone=GMT`
    + `&past_days=${pastDays}`
    + `&forecast_days=${forecastDays}`
  );
}

// ----------------------------- Response Parsers ----------------------------

interface OpenMeteoHourlyResponse {
  hourly: {
    time: string[];
    shortwave_radiation: (number | null)[];
  };
}

/**
 * Parse an Open-Meteo hourly response into IrradianceRecord[].
 *
 * Handles the backward-averaging alignment:
 *   Open-Meteo labels hour 14:00 = average over 13:00–14:00.
 *   HA labels the same interval as hour 13.
 *   We convert: intervalStartHour = (omHour + 23) % 24.
 *   And shift the timestamp back 1 hour to represent the interval start.
 *
 * Null radiation values are treated as 0 (nighttime or missing data).
 */
export function parseIrradianceResponse(data: OpenMeteoHourlyResponse): IrradianceRecord[] {
  const records: IrradianceRecord[] = [];

  const { time, shortwave_radiation } = data.hourly;

  for (let i = 0; i < time.length; i++) {
    const omDate = new Date(time[i] + 'Z');  // Append Z since timezone=GMT
    const omHour = omDate.getUTCHours();

    // Backward-averaging alignment: shift to interval start
    const intervalStartHour = (omHour + 23) % 24;
    const intervalStartTime = omDate.getTime() - 3600000; // shift back 1 hour

    const ghi = shortwave_radiation[i] ?? 0;

    records.push({
      time: intervalStartTime,
      hour: intervalStartHour,
      ghi_W_per_m2: Math.max(0, ghi),
    });
  }

  return records;
}
