/**
 * open-meteo-client.ts
 *
 * Thin HTTP wrapper around the Open-Meteo API.
 * Uses the pure URL builders and response parsers from lib/open-meteo.ts.
 */

import { buildArchiveUrl, buildForecastUrl, buildTemperatureUrl, parseIrradianceResponse, parseForecastResponse, parseTemperatureResponse } from '../../lib/open-meteo.ts';
import type { IrradianceRecord } from '../../lib/predict-pv.ts';
import type { TemperatureRecord } from '../../lib/load-predictor-temperature.ts';
import { fetchWithTimeout } from '../../lib/fetch-utils.ts';

const OPEN_METEO_TIMEOUT_MS = 15000;

/**
 * Fetch historical irradiance data from the Open-Meteo Archive API.
 */
export async function fetchArchiveIrradiance(
  lat: number,
  lon: number,
  startDate: string,
  endDate: string,
  timeoutMs = OPEN_METEO_TIMEOUT_MS,
): Promise<IrradianceRecord[]> {
  const url = buildArchiveUrl({ latitude: lat, longitude: lon, startDate, endDate });
  const response = await fetchWithTimeout(
    url,
    {},
    { timeoutMs, label: 'Open-Meteo Archive API request' },
  );

  if (!response.ok) {
    throw new Error(`Open-Meteo Archive API returned status ${response.status}`);
  }

  const data = await response.json();
  return parseIrradianceResponse(data);
}

/**
 * Fetch forecast irradiance data from the Open-Meteo Forecast API.
 *
 * The default ICON D2 model only covers ~2 days; for longer windows we fall
 * back to ICON seamless (D2 → EU → global blend) unless a model is given, so
 * far-out slots get real irradiance instead of nulls (which parse to 0 W).
 */
export async function fetchForecastIrradiance(
  lat: number,
  lon: number,
  model?: string,
  resolution: 15 | 60 = 60,
  forecastDays = 2,
  timeoutMs = OPEN_METEO_TIMEOUT_MS,
): Promise<IrradianceRecord[]> {
  const effectiveModel = model ?? (forecastDays > 2 ? 'icon_seamless' : undefined);
  const url = buildForecastUrl({ latitude: lat, longitude: lon, model: effectiveModel, pastDays: 1, forecastDays, resolution });
  const response = await fetchWithTimeout(
    url,
    {},
    { timeoutMs, label: 'Open-Meteo Forecast API request' },
  );

  if (!response.ok) {
    throw new Error(`Open-Meteo Forecast API returned status ${response.status}`);
  }

  const data = await response.json();
  return parseForecastResponse(data, resolution);
}

/**
 * Fetch hourly outside temperature (past + forecast) from the Open-Meteo
 * Forecast API. pastDays is capped at 92 and forecastDays at 16 (API limits).
 */
export async function fetchTemperatureSeries(
  lat: number,
  lon: number,
  pastDays: number,
  forecastDays: number,
  timeoutMs = OPEN_METEO_TIMEOUT_MS,
): Promise<TemperatureRecord[]> {
  const url = buildTemperatureUrl({
    latitude: lat,
    longitude: lon,
    pastDays: Math.min(pastDays, 92),
    forecastDays: Math.min(forecastDays, 16),
  });
  const response = await fetchWithTimeout(
    url,
    {},
    { timeoutMs, label: 'Open-Meteo Forecast API request' },
  );

  if (!response.ok) {
    throw new Error(`Open-Meteo Forecast API returned status ${response.status}`);
  }

  const data = await response.json();
  return parseTemperatureResponse(data);
}
