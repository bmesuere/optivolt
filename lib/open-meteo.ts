/**
 * open-meteo.ts
 *
 * Pure URL builders and response parsers for the Open-Meteo API.
 * No I/O — the actual HTTP calls live in api/services/open-meteo-client.ts.
 */

import type { IrradianceRecord } from './predict-pv.ts';

// ----------------------------- URL Builders --------------------------------

const RADIATION_VARIABLES = 'shortwave_radiation,direct_radiation,diffuse_radiation';

interface ArchiveUrlParams {
  latitude: number;
  longitude: number;
  startDate: string;  // YYYY-MM-DD
  endDate: string;    // YYYY-MM-DD
}

/**
 * Build URL for the Open-Meteo Archive API.
 * Requests hourly radiation variables in UTC (timezone=GMT).
 */
export function buildArchiveUrl({ latitude, longitude, startDate, endDate }: ArchiveUrlParams): string {
  return (
    `https://archive-api.open-meteo.com/v1/archive`
    + `?latitude=${latitude}&longitude=${longitude}`
    + `&start_date=${startDate}&end_date=${endDate}`
    + `&hourly=${RADIATION_VARIABLES}&timezone=GMT`
  );
}

interface ForecastUrlParams {
  latitude: number;
  longitude: number;
  model?: string;
  pastDays?: number;
  forecastDays?: number;
  resolution?: 15 | 60;
}

/**
 * Build URL for the Open-Meteo Forecast API.
 * Uses the ICON D2 model by default (good European coverage).
 * Requests radiation variables in UTC (timezone=GMT).
 * When resolution=15, uses minutely_15 data; otherwise uses hourly.
 */
export function buildForecastUrl({
  latitude,
  longitude,
  model = 'icon_d2',
  pastDays = 1,
  forecastDays = 2,
  resolution = 60,
}: ForecastUrlParams): string {
  const radiationParam = resolution === 15
    ? `&minutely_15=${RADIATION_VARIABLES}`
    : `&hourly=${RADIATION_VARIABLES}`;
  return (
    `https://api.open-meteo.com/v1/forecast`
    + `?latitude=${latitude}&longitude=${longitude}`
    + radiationParam
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
    direct_radiation?: (number | null)[];
    diffuse_radiation?: (number | null)[];
  };
}

function radiationValue(values: (number | null)[] | undefined, index: number): number {
  return Math.max(0, values?.[index] ?? 0);
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

  const { time, shortwave_radiation, direct_radiation, diffuse_radiation } = data.hourly;

  for (let i = 0; i < time.length; i++) {
    const omDate = new Date(time[i] + 'Z');  // Append Z since timezone=GMT
    const omHour = omDate.getUTCHours();

    // Backward-averaging alignment: shift to interval start
    const intervalStartHour = (omHour + 23) % 24;
    const intervalStartTime = omDate.getTime() - 3600000; // shift back 1 hour

    records.push({
      time: intervalStartTime,
      hour: intervalStartHour,
      ghi_W_per_m2: radiationValue(shortwave_radiation, i),
      directRadiation_W_per_m2: radiationValue(direct_radiation, i),
      diffuseRadiation_W_per_m2: radiationValue(diffuse_radiation, i),
      intervalMinutes: 60,
    });
  }

  return records;
}

// ----------------------------- 15-min Parser ------------------------------

interface OpenMeteoMinutely15Response {
  minutely_15: {
    time: string[];
    shortwave_radiation: (number | null)[];
    direct_radiation?: (number | null)[];
    diffuse_radiation?: (number | null)[];
  };
}

/**
 * Parse an Open-Meteo minutely_15 response into IrradianceRecord[].
 *
 * Unlike the hourly response, Open-Meteo labels 15-min data at interval start,
 * so no backward-averaging shift is needed.
 *
 * Null radiation values are treated as 0 (nighttime or missing data).
 */
export function parseMinutely15Response(data: OpenMeteoMinutely15Response): IrradianceRecord[] {
  const records: IrradianceRecord[] = [];

  const { time, shortwave_radiation, direct_radiation, diffuse_radiation } = data.minutely_15;

  for (let i = 0; i < time.length; i++) {
    const date = new Date(time[i] + 'Z');  // Append Z since timezone=GMT
    const hour = date.getUTCHours();
    records.push({
      time: date.getTime(),
      hour,
      ghi_W_per_m2: radiationValue(shortwave_radiation, i),
      directRadiation_W_per_m2: radiationValue(direct_radiation, i),
      diffuseRadiation_W_per_m2: radiationValue(diffuse_radiation, i),
      intervalMinutes: 15,
    });
  }

  return records;
}

/**
 * Expand hourly IrradianceRecords into 15-minute records for validation.
 *
 * Each hourly record is split into 4 × 15-min records with the same GHI value
 * but timestamps at +0, +15, +30, +45 minutes within the hour.
 * This allows forecastPvSlot() to evaluate Bird clear-sky at each 15-min
 * mid-interval and match against 15-min actuals from HA.
 */
export function expandHourlyTo15Min(records: IrradianceRecord[]): IrradianceRecord[] {
  const expanded: IrradianceRecord[] = [];
  for (const rec of records) {
    for (let q = 0; q < 4; q++) {
      const slotMs = rec.time + q * 15 * 60 * 1000;
      expanded.push({
        time: slotMs,
        hour: new Date(slotMs).getUTCHours(),
        ghi_W_per_m2: rec.ghi_W_per_m2,
        directRadiation_W_per_m2: rec.directRadiation_W_per_m2,
        diffuseRadiation_W_per_m2: rec.diffuseRadiation_W_per_m2,
        intervalMinutes: 15,
      });
    }
  }
  return expanded;
}

/**
 * Dispatch to the appropriate parser based on resolution.
 */
export function parseForecastResponse(data: unknown, resolution: 15 | 60): IrradianceRecord[] {
  if (resolution === 15) {
    return parseMinutely15Response(data as OpenMeteoMinutely15Response);
  }
  return parseIrradianceResponse(data as OpenMeteoHourlyResponse);
}
