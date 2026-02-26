/**
 * open-meteo-client.ts
 *
 * Thin HTTP wrapper around the Open-Meteo API.
 * Uses the pure URL builders and response parsers from lib/open-meteo.ts.
 */

import { buildArchiveUrl, buildForecastUrl, parseIrradianceResponse } from '../../lib/open-meteo.ts';
import type { IrradianceRecord } from '../../lib/predict-pv.ts';

/**
 * Fetch historical irradiance data from the Open-Meteo Archive API.
 */
export async function fetchArchiveIrradiance(
  lat: number,
  lon: number,
  startDate: string,
  endDate: string,
): Promise<IrradianceRecord[]> {
  const url = buildArchiveUrl({ latitude: lat, longitude: lon, startDate, endDate });
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Open-Meteo Archive API returned status ${response.status}`);
  }

  const data = await response.json();
  return parseIrradianceResponse(data);
}

/**
 * Fetch forecast irradiance data from the Open-Meteo Forecast API.
 */
export async function fetchForecastIrradiance(
  lat: number,
  lon: number,
  model?: string,
): Promise<IrradianceRecord[]> {
  const url = buildForecastUrl({ latitude: lat, longitude: lon, model, pastDays: 1, forecastDays: 2 });
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Open-Meteo Forecast API returned status ${response.status}`);
  }

  const data = await response.json();
  return parseIrradianceResponse(data);
}
