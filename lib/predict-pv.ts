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

// ----------------------------- Helpers -----------------------------------

/** Estimate clear-sky capacity: maxProd / maxRatio, with fallback when ratio is too low. */
function estimateCapacity(maxProduction: number, maxRatio: number): number {
  return maxRatio > 0.1 ? maxProduction / maxRatio : maxProduction;
}

// ----------------------------- Types -------------------------------------

export interface IrradianceRecord {
  time: number;          // timestamp ms (start of UTC hour interval)
  hour: number;          // 0–23 UTC hour (start of interval)
  ghi_W_per_m2: number;  // shortwave radiation (W/m²)
  directRadiation_W_per_m2?: number;   // direct horizontal radiation (W/m²)
  diffuseRadiation_W_per_m2?: number;  // diffuse radiation (W/m²)
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
  directRadiation_W_per_m2?: number;
  diffuseRadiation_W_per_m2?: number;
  forecastRatio: number;         // ghiForecast / ghiClear
}

export interface PvLinearModel {
  index: number;             // hour (0-23) or slot (0-95)
  directCoeff: number;       // W PV per W/m² direct radiation
  diffuseCoeff: number;      // W PV per W/m² diffuse radiation
  sampleCount: number;
  excludedCount: number;
  fallback: boolean;
}

interface PvLinearSample {
  direct: number;
  diffuse: number;
  production_W: number;
  fallback_W?: number;
}

interface PvLinearFitOptions {
  minSamples: number;
  minCrossValidationSamples: number;
  minStrongRadiation_W_per_m2: number;
  lowOutlierRatio: number;
  minOutlierDelta_W: number;
  minFallbackImprovementRatio: number;
  ridgeLambda: number;
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

    capacity.push({
      hour: h,
      maxProduction_Wh: mp,
      maxRatio: mr,
      trueCapacity_Wh: estimateCapacity(mp, mr),
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

    capacity.push({
      slot: s,
      maxProduction_Wh: mp,
      maxRatio: mr,
      trueCapacity_Wh: estimateCapacity(mp, mr),
    });
  }

  return capacity;
}

// ----------------------------- Robust Linear Capacity ---------------------

const DEFAULT_LINEAR_FIT_OPTIONS: PvLinearFitOptions = {
  minSamples: 3,
  minCrossValidationSamples: 4,
  minStrongRadiation_W_per_m2: 120,
  lowOutlierRatio: 0.35,
  minOutlierDelta_W: 300,
  minFallbackImprovementRatio: 0.05,
  ridgeLambda: 1,
};

function fallbackLinearModel(index: number): PvLinearModel {
  return {
    index,
    directCoeff: 0,
    diffuseCoeff: 0,
    sampleCount: 0,
    excludedCount: 0,
    fallback: true,
  };
}

function getRadiationFeatures(rec: IrradianceRecord): { direct: number; diffuse: number } | null {
  const direct = rec.directRadiation_W_per_m2;
  const diffuse = rec.diffuseRadiation_W_per_m2;
  if (!Number.isFinite(direct) || !Number.isFinite(diffuse)) return null;
  return {
    direct: Math.max(0, direct ?? 0),
    diffuse: Math.max(0, diffuse ?? 0),
  };
}

function fitNonNegativeRidge(samples: PvLinearSample[], options: PvLinearFitOptions): { directCoeff: number; diffuseCoeff: number } | null {
  let sDD = options.ridgeLambda;
  let sFF = options.ridgeLambda;
  let sDF = 0;
  let tD = 0;
  let tF = 0;

  for (const sample of samples) {
    const { direct, diffuse, production_W } = sample;
    sDD += direct * direct;
    sFF += diffuse * diffuse;
    sDF += direct * diffuse;
    tD += direct * production_W;
    tF += diffuse * production_W;
  }

  const candidates: { directCoeff: number; diffuseCoeff: number }[] = [];
  const det = sDD * sFF - sDF * sDF;

  if (Math.abs(det) > 1e-9) {
    candidates.push({
      directCoeff: (tD * sFF - tF * sDF) / det,
      diffuseCoeff: (sDD * tF - sDF * tD) / det,
    });
  }

  candidates.push({ directCoeff: tD / sDD, diffuseCoeff: 0 });
  candidates.push({ directCoeff: 0, diffuseCoeff: tF / sFF });
  candidates.push({ directCoeff: 0, diffuseCoeff: 0 });

  let best: { directCoeff: number; diffuseCoeff: number } | null = null;
  let bestLoss = Infinity;

  for (const candidate of candidates) {
    const directCoeff = Math.max(0, candidate.directCoeff);
    const diffuseCoeff = Math.max(0, candidate.diffuseCoeff);
    let loss = options.ridgeLambda * (directCoeff * directCoeff + diffuseCoeff * diffuseCoeff);
    for (const sample of samples) {
      const predicted = directCoeff * sample.direct + diffuseCoeff * sample.diffuse;
      const error = sample.production_W - predicted;
      loss += error * error;
    }
    if (loss < bestLoss) {
      bestLoss = loss;
      best = { directCoeff, diffuseCoeff };
    }
  }

  if (!best || !Number.isFinite(best.directCoeff) || !Number.isFinite(best.diffuseCoeff)) return null;
  if (best.directCoeff + best.diffuseCoeff <= 1e-9) return null;
  return best;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function predictLinear(fit: { directCoeff: number; diffuseCoeff: number }, sample: Pick<PvLinearSample, 'direct' | 'diffuse'>): number {
  return Math.max(0, fit.directCoeff * sample.direct + fit.diffuseCoeff * sample.diffuse);
}

function fitWithOutlierPass(samples: PvLinearSample[], options: PvLinearFitOptions): {
  fit: { directCoeff: number; diffuseCoeff: number } | null;
  sampleCount: number;
  excludedCount: number;
} {
  const initial = fitNonNegativeRidge(samples, options);
  if (!initial) return { fit: null, sampleCount: samples.length, excludedCount: 0 };

  const outliers = lowOutlierIndexes(samples, initial, options);
  if (outliers.size > 0 && samples.length - outliers.size >= options.minSamples) {
    const filtered = samples.filter((_sample, i) => !outliers.has(i));
    const refit = fitNonNegativeRidge(filtered, options);
    if (refit) return { fit: refit, sampleCount: filtered.length, excludedCount: outliers.size };
  }

  return { fit: initial, sampleCount: samples.length, excludedCount: 0 };
}

function lowOutlierIndexes(
  samples: PvLinearSample[],
  fit: { directCoeff: number; diffuseCoeff: number },
  options: PvLinearFitOptions,
): Set<number> {
  const totals = samples.map(s => s.direct + s.diffuse);
  const strongThreshold = Math.max(options.minStrongRadiation_W_per_m2, Math.max(...totals) * 0.35);
  const strongRatios = samples
    .map((sample, i) => ({ sample, total: totals[i] }))
    .filter(({ sample, total }) => total >= strongThreshold && sample.production_W > 0)
    .map(({ sample, total }) => sample.production_W / Math.max(1, total));
  const medianRatio = median(strongRatios);
  const outliers = new Set<number>();

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    const total = totals[i];
    if (total < strongThreshold) continue;

    const trainingWithoutSample = samples.filter((_other, j) => j !== i);
    const leaveOneOutFit = trainingWithoutSample.length >= options.minSamples
      ? fitNonNegativeRidge(trainingWithoutSample, options)
      : null;
    const predicted = leaveOneOutFit
      ? predictLinear(leaveOneOutFit, sample)
      : predictLinear(fit, sample);
    const modelLow = predicted >= options.minOutlierDelta_W
      && sample.production_W < predicted * options.lowOutlierRatio
      && predicted - sample.production_W >= options.minOutlierDelta_W;
    const ratioLow = medianRatio > 0
      && sample.production_W / Math.max(1, total) < medianRatio * options.lowOutlierRatio
      && medianRatio * total - sample.production_W >= options.minOutlierDelta_W;

    if (modelLow || ratioLow) outliers.add(i);
  }

  return outliers;
}

function crossValidatedLinearMae(samples: PvLinearSample[], options: PvLinearFitOptions): number | null {
  const fallbackCount = samples.filter(s => s.fallback_W != null).length;
  if (fallbackCount < options.minCrossValidationSamples) return null;

  let sumAbs = 0;
  let count = 0;

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    if (sample.fallback_W == null) continue;
    const training = samples.filter((_other, j) => j !== i);
    if (training.length < options.minSamples) continue;

    const fit = fitNonNegativeRidge(training, options);
    if (!fit) continue;

    sumAbs += Math.abs(sample.production_W - predictLinear(fit, sample));
    count++;
  }

  return count >= options.minCrossValidationSamples ? sumAbs / count : null;
}

function fallbackMae(samples: PvLinearSample[]): number | null {
  let sumAbs = 0;
  let count = 0;

  for (const sample of samples) {
    if (sample.fallback_W == null) continue;
    sumAbs += Math.abs(sample.production_W - sample.fallback_W);
    count++;
  }

  return count > 0 ? sumAbs / count : null;
}

function fitRobustLinearModel(index: number, samples: PvLinearSample[], options: PvLinearFitOptions): PvLinearModel {
  if (samples.length < options.minSamples) return fallbackLinearModel(index);

  const { fit, sampleCount, excludedCount } = fitWithOutlierPass(samples, options);
  if (!fit) return fallbackLinearModel(index);

  const cvMae = crossValidatedLinearMae(samples, options);
  const baseMae = fallbackMae(samples);
  // baseMae exists but cvMae is null: enough fallback data to judge but not enough to cross-validate
  // the linear model — distrust it conservatively.
  if (baseMae != null && cvMae == null) {
    return {
      index,
      ...fit,
      sampleCount,
      excludedCount,
      fallback: true,
    };
  }
  if (
    cvMae != null
    && baseMae != null
    && cvMae >= baseMae * (1 - options.minFallbackImprovementRatio)
  ) {
    return {
      index,
      ...fit,
      sampleCount,
      excludedCount,
      fallback: true,
    };
  }

  return {
    index,
    ...fit,
    sampleCount,
    excludedCount,
    fallback: false,
  };
}

/**
 * Estimate per-hour or per-15-minute-slot PV models using direct + diffuse
 * radiation. Zero production samples are treated as invalid sensor/curtailment
 * observations. Low non-zero outliers under strong radiation are treated as
 * likely derating and excluded before a second fit.
 */
export function estimateRobustLinearPvModels(
  productionRecords: PvProductionRecord[],
  irradiance: IrradianceRecord[],
  bucketCount: 24 | 96,
  fallbackPoints?: Map<number, PvForecastPoint>,
): PvLinearModel[] {
  const options = DEFAULT_LINEAR_FIT_OPTIONS;
  const productionByTime = new Map<number, number>();
  for (const rec of productionRecords) {
    if (Number.isFinite(rec.production_Wh) && rec.production_Wh > 0) {
      productionByTime.set(rec.time, rec.production_Wh);
    }
  }

  const samplesByIndex = Array.from({ length: bucketCount }, () => [] as PvLinearSample[]);

  for (const rec of irradiance) {
    const production_W = productionByTime.get(rec.time);
    if (production_W == null) continue;
    const features = getRadiationFeatures(rec);
    if (!features) continue;
    if (features.direct + features.diffuse <= 5) continue;

    const index = bucketCount === 96 ? slotOfDay(rec.time) : rec.hour;
    const fallback_W = fallbackPoints?.get(rec.time)?.predicted ?? undefined;
    samplesByIndex[index].push({ ...features, production_W, fallback_W });
  }

  return samplesByIndex.map((samples, index) => fitRobustLinearModel(index, samples, options));
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
      directRadiation_W_per_m2: rec.directRadiation_W_per_m2,
      diffuseRadiation_W_per_m2: rec.diffuseRadiation_W_per_m2,
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
      directRadiation_W_per_m2: rec.directRadiation_W_per_m2,
      diffuseRadiation_W_per_m2: rec.diffuseRadiation_W_per_m2,
      forecastRatio,
      predicted: Math.max(0, prediction),
      actual,
    });
  }

  return points;
}

/**
 * Generate PV forecast points from robust per-hour or per-slot direct+diffuse
 * radiation models. Missing or unstable model buckets fall back to the supplied
 * clear-sky forecast point for the same timestamp.
 */
export function forecastPvLinear(
  models: PvLinearModel[],
  forecastIrradiance: IrradianceRecord[],
  lat: number,
  lon: number,
  actuals?: Map<number, number>,
  fallbackPoints?: Map<number, PvForecastPoint>,
): PvForecastPoint[] {
  const useSlots = models.length === 96;
  const points: PvForecastPoint[] = [];

  for (const rec of forecastIrradiance) {
    const bucket = useSlots ? slotOfDay(rec.time) : rec.hour;
    const model = models[bucket];
    const features = getRadiationFeatures(rec);
    const fallback = fallbackPoints?.get(rec.time);

    const midInterval = new Date(rec.time + (rec.intervalMinutes / 2) * 60 * 1000);
    const ghiClear = fallback?.ghiClear_W_per_m2 ?? calculateClearSkyGHI(lat, lon, midInterval);
    const forecastRatio = ghiClear > 5 ? rec.ghi_W_per_m2 / ghiClear : 0;

    let predicted = fallback?.predicted ?? 0;
    if (features && model && !model.fallback) {
      predicted = model.directCoeff * features.direct + model.diffuseCoeff * features.diffuse;
    }

    points.push({
      time: rec.time,
      hour: rec.hour,
      ghiClear_W_per_m2: ghiClear,
      ghiForecast_W_per_m2: rec.ghi_W_per_m2,
      directRadiation_W_per_m2: features?.direct,
      diffuseRadiation_W_per_m2: features?.diffuse,
      forecastRatio,
      predicted: Math.max(0, predicted),
      actual: actuals?.get(rec.time) ?? null,
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
