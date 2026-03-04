/**
 * predict-pv.ts
 *
 * Pure PV forecasting logic — no I/O.
 *
 * Algorithm overview:
 *   1. From HA history, find the max production (Wh) for each UTC hour.
 *   2. From Open-Meteo archive, find the max ratio (GHI_actual / GHI_clear)
 *      for each UTC hour using the Bird Clear Sky Model.
 *   3. Estimate "true capacity" per hour: what the system would produce at
 *      100% clear sky = maxProduction / maxRatio.
 *   4. For each forecast hour, compute prediction = forecastRatio × trueCapacity,
 *      where forecastRatio = GHI_forecast / GHI_clear.
 *
 * Time alignment:
 *   - HA statistics use start-of-interval: hour 13 = 13:00–14:00.
 *   - Open-Meteo backward-averages: hour 14:00 = 13:00–14:00.
 *   - Alignment: intervalStartHour = (omHour + 23) % 24.
 *   - Bird Clear Sky: evaluated at mid-interval (e.g. 13:30 UTC).
 */

import { type ForecastSeries, computeErrorMetrics, type PredictionResult, type ValidationMetrics } from './time-series-utils.ts';

// ----------------------------- Types -------------------------------------

export interface IrradianceRecord {
  time: number;          // timestamp ms (start of UTC hour interval)
  hour: number;          // 0–23 UTC hour (start of interval)
  ghi_W_per_m2: number;  // shortwave radiation (W/m²)
  intervalMinutes: number;  // 60 for hourly, 15 for minutely_15
}

export interface PvProductionRecord {
  time: number;          // timestamp ms (start of interval)
  hour: number;          // 0–23 UTC hour
  slot?: number;         // 0–95 slot index (set when using 15-min history)
  production_Wh: number; // energy produced in this interval
}

export interface HourlyCapacity {
  hour: number;              // 0–23 UTC hour
  maxProduction_Wh: number;  // best observed production for this hour
  maxRatio: number;          // best observed GHI_actual / GHI_clear ratio
  trueCapacity_Wh: number;  // estimated 100%-clear-sky production
}

export interface SlotCapacity {
  slot: number;              // 0–95 (hour * 4 + quarter, UTC)
  maxProduction_Wh: number;  // best observed production for this 15-min slot
  maxRatio: number;          // hourly max ratio (shared across 4 slots in same hour)
  trueCapacity_Wh: number;   // estimated 100%-clear-sky production
}

export interface PvForecastPoint extends PredictionResult {
  ghiClear_W_per_m2: number;     // Bird model clear-sky baseline
  ghiForecast_W_per_m2: number;  // Open-Meteo forecast/archive value
  forecastRatio: number;         // ghiForecast / ghiClear
}

// ----------------------------- Bird Clear Sky Model -----------------------

/**
 * Calculate approximate clear-sky Global Horizontal Irradiance (GHI)
 * using the Bird Clear Sky Model with simplified atmospheric parameters.
 *
 * Reference: Bird, R.E. (1981), "A Simplified Clear Sky Model for Direct
 * and Diffuse Insolation on Horizontal Surfaces", SERI/TR-642-761.
 *
 * The model computes:
 *   1. Solar position (zenith, elevation) from latitude, longitude, date.
 *   2. Extraterrestrial radiation adjusted for earth-sun distance.
 *   3. Atmospheric transmittance: Rayleigh scattering, ozone absorption,
 *      uniform mixed gas absorption, water vapor, aerosol extinction.
 *   4. Direct Normal Irradiance (DNI) and Diffuse Horizontal Irradiance (DHI).
 *   5. GHI = DNI × cos(zenith) + DHI.
 *
 * Uses getUTCHours() + longitude offset for solar time, making it
 * timezone-independent.
 *
 * @param lat  Latitude in degrees
 * @param lon  Longitude in degrees
 * @param date Date object (UTC time used internally)
 * @returns GHI in W/m² (0 if sun is below horizon)
 */
export function calculateClearSkyGHI(lat: number, lon: number, date: Date): number {
  const latRad = lat * Math.PI / 180;

  // Day of year (1-indexed)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 0));
  const diff = date.getTime() - yearStart.getTime();
  const dayOfYear = Math.floor(diff / 86400000);

  // Fractional year (gamma) — Spencer (1971)
  const gamma = (2 * Math.PI / 365) * (dayOfYear - 1 + (date.getUTCHours() - 12) / 24);

  // Equation of time (minutes) — Spencer (1971)
  const eqTime = 229.18 * (
    0.000075
    + 0.001868 * Math.cos(gamma)
    - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma)
    - 0.040849 * Math.sin(2 * gamma)
  );

  // Solar declination angle (radians) — Spencer (1971)
  const declination =
    0.006918
    - 0.399912 * Math.cos(gamma)
    + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma)
    + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma)
    + 0.00148 * Math.sin(3 * gamma);

  // Solar time: UTC time + equation of time + longitude correction (4 min/degree)
  const timeOffset = eqTime + 4 * lon;
  const solarTime =
    date.getUTCHours()
    + date.getUTCMinutes() / 60
    + date.getUTCSeconds() / 3600
    + timeOffset / 60;

  // Hour angle (radians): 0° at solar noon, 15°/hour
  const hourAngle = (solarTime - 12) * 15 * Math.PI / 180;

  // Solar zenith angle
  const cosZenith =
    Math.sin(latRad) * Math.sin(declination)
    + Math.cos(latRad) * Math.cos(declination) * Math.cos(hourAngle);
  const zenith = Math.acos(Math.max(-1, Math.min(1, cosZenith)));
  const elevation = Math.PI / 2 - zenith;

  // Sun below horizon → no irradiance
  if (elevation <= 0) return 0;

  // Extraterrestrial radiation adjusted for earth-sun distance variation
  // Solar constant ≈ 1367 W/m²
  const extraterrestrialRadiation = 1367 * (
    1.000110
    + 0.034221 * Math.cos(gamma)
    + 0.001280 * Math.sin(gamma)
    + 0.000719 * Math.cos(2 * gamma)
    + 0.000077 * Math.sin(2 * gamma)
  );

  // Air mass — Kasten & Young (1989) approximation
  const zenithDeg = zenith * 180 / Math.PI;
  const airMass = 1 / (Math.cos(zenith) + 0.50572 * Math.pow(96.07995 - zenithDeg, -1.6364));

  // --- Atmospheric transmittance components ---

  // Rayleigh scattering
  const tRayleigh = Math.exp(
    -0.0903 * Math.pow(airMass, 0.84) * (1.0 + airMass - Math.pow(airMass, 1.01))
  );

  // Ozone absorption (ozone column thickness ≈ 0.3 cm)
  const oz = 0.3;
  const ozAm = oz * airMass;
  const tOzone = 1
    - (0.1611 * ozAm) / Math.pow(1 + 139.48 * ozAm, 0.3035)
    - 0.002715 * ozAm / (1 + 0.044 * ozAm + 0.0003 * ozAm * ozAm);

  // Uniform mixed gas absorption
  const tGases = Math.exp(-0.0127 * Math.pow(airMass, 0.26));

  // Water vapor absorption (precipitable water ≈ 1.5 cm)
  const pw = 1.5;
  const pwAm = pw * airMass;
  const tWater = 1 - (2.4959 * pwAm) / (Math.pow(1 + 79.034 * pwAm, 0.6828) + 6.385 * pwAm);

  // Aerosol extinction (AOD ≈ 0.1 at 500nm for clear conditions)
  const aod = 0.1;
  const tAerosol = Math.exp(
    -Math.pow(aod, 0.873) * (1 + aod - Math.pow(aod, 0.7088)) * Math.pow(airMass, 0.9108)
  );

  // Combined direct-beam transmittance
  const directTransmittance = tRayleigh * tOzone * tGases * tWater * tAerosol;

  // Direct Normal Irradiance
  const dni = extraterrestrialRadiation * directTransmittance;

  // Diffuse Horizontal Irradiance (simplified Bird model)
  const dhi =
    extraterrestrialRadiation * cosZenith * 0.79 * tOzone * tGases * tWater
    * (0.5 * (1 - tRayleigh) + 0.85 * (1 - tAerosol))
    / (1 - airMass + Math.pow(airMass, 1.02));

  // Global Horizontal Irradiance = direct horizontal + diffuse
  const ghi = dni * cosZenith + dhi;

  // 1.10 tuning factor: numerical weather models like ICON scale slightly
  // upward due to 3D cloud-edge effects in standard output
  return Math.max(0, ghi * 1.10);
}

// ----------------------------- Capacity Estimation ------------------------

/**
 * Find the maximum production (Wh) for each UTC hour (0–23)
 * across all history records. Records are grouped by hour, then
 * the max value per hour is returned.
 */
export function calculateMaxProductionPerHour(records: PvProductionRecord[]): number[] {
  const maxPerHour = new Array<number>(24).fill(0);

  for (const rec of records) {
    if (rec.production_Wh > maxPerHour[rec.hour]) {
      maxPerHour[rec.hour] = rec.production_Wh;
    }
  }

  return maxPerHour;
}

/**
 * For each hour of the day, find the maximum ratio of measured GHI
 * to Bird clear-sky GHI across all archive irradiance records.
 *
 * This tells us the best weather we've observed per hour slot
 * in the archive period (typically 14 days). A max ratio near 1.0
 * means we saw a nearly perfect clear-sky day for that hour;
 * a ratio of 0.5 means the best day was still about half-cloudy.
 *
 * Open-Meteo backward-averaging alignment:
 *   omHour 14:00 = average over 13:00–14:00 → intervalStartHour = 13
 *   Bird GHI is evaluated at mid-interval (13:30 UTC).
 */
export function calculateMaxRatioPerHour(
  irradiance: IrradianceRecord[],
  lat: number,
  lon: number,
): number[] {
  const maxRatioPerHour = new Array<number>(24).fill(0);

  for (const rec of irradiance) {
    // Bird GHI at mid-interval. rec.time is already the interval start,
    // but Open-Meteo originally labels it as the end of the backward-averaged
    // interval. The parser already did (omHour + 23) % 24 so rec.hour is
    // the start hour and rec.time is the start timestamp.
    const midInterval = new Date(rec.time + (rec.intervalMinutes / 2) * 60 * 1000);
    const ghiClear = calculateClearSkyGHI(lat, lon, midInterval);

    // Skip low-sun records where the ratio is unreliable
    if (ghiClear < 20 || rec.ghi_W_per_m2 <= 0) continue;

    const ratio = rec.ghi_W_per_m2 / ghiClear;
    if (ratio > maxRatioPerHour[rec.hour]) {
      maxRatioPerHour[rec.hour] = ratio;
    }
  }

  return maxRatioPerHour;
}

/**
 * Combine max production and max ratio into an hourly capacity estimate.
 *
 * trueCapacity = maxProd / maxRatio when maxRatio > 0.1.
 * If maxRatio is very low (< 0.1), the archive had almost no sunshine
 * for that hour, so we fall back to the raw max production.
 */
export function estimateHourlyCapacity(
  maxProd: number[],
  maxRatio: number[],
): HourlyCapacity[] {
  const capacity: HourlyCapacity[] = [];

  for (let h = 0; h < 24; h++) {
    const mp = maxProd[h] ?? 0;
    const mr = maxRatio[h] ?? 0;
    const trueCapacity = mr > 0.1 ? mp / mr : mp;

    capacity.push({
      hour: h,
      maxProduction_Wh: mp,
      maxRatio: mr,
      trueCapacity_Wh: trueCapacity,
    });
  }

  return capacity;
}

// ----------------------------- 15-min Slot Capacity -----------------------

/**
 * Return the slot index (0-95) for a given UTC timestamp.
 * slot = hour * 4 + floor(minute / 15)
 */
export function slotOfDay(timeMs: number): number {
  const d = new Date(timeMs);
  return d.getUTCHours() * 4 + Math.floor(d.getUTCMinutes() / 15);
}

/**
 * Find the maximum production (Wh) for each 15-min slot (0-95) across all
 * history records. Records must have a `slot` field (use slotOfDay to set it).
 */
export function calculateMaxProductionPerSlot(records: PvProductionRecord[]): number[] {
  const maxPerSlot = new Array<number>(96).fill(0);

  for (const rec of records) {
    const slot = rec.slot ?? rec.hour * 4;
    if (rec.production_Wh > maxPerSlot[slot]) {
      maxPerSlot[slot] = rec.production_Wh;
    }
  }

  return maxPerSlot;
}

/**
 * Combine 96-slot max production with 24-hour max ratio into slot capacity.
 *
 * maxRatio is still hourly (Open-Meteo archive limitation), so the same
 * hourly ratio is shared across all 4 slots within an hour.
 * trueCapacity[s] = maxProd[s] / maxRatio[floor(s/4)] when ratio > 0.1.
 */
export function estimateSlotCapacity(
  maxProd96: number[],
  maxRatio24: number[],
): SlotCapacity[] {
  const capacity: SlotCapacity[] = [];

  for (let s = 0; s < 96; s++) {
    const h = Math.floor(s / 4);
    const mp = maxProd96[s] ?? 0;
    const mr = maxRatio24[h] ?? 0;
    const trueCapacity = mr > 0.1 ? mp / mr : mp;

    capacity.push({
      slot: s,
      maxProduction_Wh: mp,
      maxRatio: mr,
      trueCapacity_Wh: trueCapacity,
    });
  }

  return capacity;
}

/**
 * Generate PV forecast points using the 96-slot capacity model.
 *
 * Like forecastPv() but:
 *  - Capacity is looked up by slot (0-95) via slotOfDay(rec.time).
 *  - Bird clear-sky GHI is evaluated at the 15-min mid-interval
 *    (slot_start + 7.5 min) for more accurate sub-hour predictions.
 *
 * @param capacity     Per-slot capacity estimates (length 96)
 * @param forecastIrradiance  Irradiance records (already interval-start aligned)
 * @param lat          Latitude
 * @param lon          Longitude
 * @param actuals      Optional map: timestamp_ms → production_Wh
 */
export function forecastPvSlot(
  capacity: SlotCapacity[],
  forecastIrradiance: IrradianceRecord[],
  lat: number,
  lon: number,
  actuals?: Map<number, number>,
): PvForecastPoint[] {
  const points: PvForecastPoint[] = [];

  for (const rec of forecastIrradiance) {
    const slot = slotOfDay(rec.time);

    // Bird clear-sky at mid-point of this 15-min slot
    const slotStartMs = Math.floor(rec.time / 900000) * 900000;
    const midInterval = new Date(slotStartMs + 7.5 * 60 * 1000);
    const ghiClear = calculateClearSkyGHI(lat, lon, midInterval);

    let forecastRatio = 0;
    if (ghiClear > 5) {
      forecastRatio = rec.ghi_W_per_m2 / ghiClear;
    }

    const cap = capacity[slot];
    const prediction = forecastRatio * (cap?.trueCapacity_Wh ?? 0);
    const actual = actuals?.get(rec.time) ?? null;

    points.push({
      time: rec.time,
      hour: rec.hour,
      ghiClear_W_per_m2: ghiClear,
      ghiForecast_W_per_m2: rec.ghi_W_per_m2,
      forecastRatio,
      predicted: Math.max(0, prediction),
      actual,
    });
  }

  return points;
}

// ----------------------------- Forecast Generation -----------------------

/**
 * Generate PV forecast points from hourly capacity and forecast irradiance.
 *
 * For each forecast irradiance record:
 *   1. Compute Bird clear-sky GHI at mid-interval.
 *   2. forecastRatio = ghiForecast / ghiClear (0 if ghiClear < 5).
 *   3. prediction = forecastRatio × trueCapacity[hour].
 *   4. Look up actual production if available.
 *
 * @param capacity     Per-hour capacity estimates (length 24)
 * @param forecastIrradiance  Irradiance records (already interval-start aligned)
 * @param lat          Latitude
 * @param lon          Longitude
 * @param actuals      Optional map: timestamp_ms → production_Wh
 */
export function forecastPv(
  capacity: HourlyCapacity[],
  forecastIrradiance: IrradianceRecord[],
  lat: number,
  lon: number,
  actuals?: Map<number, number>,
): PvForecastPoint[] {
  const points: PvForecastPoint[] = [];

  for (const rec of forecastIrradiance) {
    // To match the hourly capacity estimation baseline, we evaluate the
    // Bird clear-sky GHI at the mid-point of the hour (HH:30) for ALL slots.
    const hourStartMs = Math.floor(rec.time / 3600000) * 3600000;
    const midInterval = new Date(hourStartMs + 30 * 60 * 1000);
    const ghiClear = calculateClearSkyGHI(lat, lon, midInterval);

    // Forecast ratio
    let forecastRatio = 0;
    if (ghiClear > 5) {
      forecastRatio = rec.ghi_W_per_m2 / ghiClear;
    }

    // Predicted production
    const cap = capacity[rec.hour];
    const prediction = forecastRatio * (cap?.trueCapacity_Wh ?? 0);

    // Actual production if available
    const actual = actuals?.get(rec.time) ?? null;

    points.push({
      time: rec.time,
      hour: rec.hour,
      ghiClear_W_per_m2: ghiClear,
      ghiForecast_W_per_m2: rec.ghi_W_per_m2,
      forecastRatio,
      predicted: Math.max(0, prediction),
      actual,
    });
  }

  return points;
}

// ----------------------------- Validation --------------------------------

/**
 * Compute validation metrics from forecast points that have actuals.
 */
export function validatePvForecast(points: PvForecastPoint[]): ValidationMetrics {
  const withActuals = points.filter(p => p.actual !== null);

  const metrics = computeErrorMetrics(
    withActuals,
    p => p.actual!,
    p => p.predicted
  );

  return {
    mae: metrics.mae,
    rmse: metrics.rmse,
    mape: metrics.mape,
    n: metrics.n,
  };
}
