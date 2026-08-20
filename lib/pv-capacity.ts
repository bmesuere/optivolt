/**
 * pv-capacity.ts
 *
 * Observation records and clear-sky capacity estimation.
 *
 * Capacity = what the system would produce at 100% clear sky, derived from
 * the best observed production and the best observed GHI_actual / GHI_clear
 * ratio for each bucket (24 UTC hours or 96 15-min slots).
 *
 * Time alignment:
 *   - HA statistics use start-of-interval: hour 13 = 13:00–14:00.
 *   - Open-Meteo backward-averages: hour 14:00 = 13:00–14:00.
 *   - Alignment: intervalStartHour = (omHour + 23) % 24.
 *   - Bird Clear Sky: evaluated at mid-interval (e.g. 13:30 UTC).
 */

import { calculateClearSkyGHI } from './pv-clear-sky.ts';

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

export interface RadiationFeatures {
  direct: number;
  diffuse: number;
}

/** Estimate clear-sky capacity: maxProd / maxRatio, with fallback when ratio is too low. */
function estimateCapacity(maxProduction: number, maxRatio: number): number {
  return maxRatio > 0.1 ? maxProduction / maxRatio : maxProduction;
}

/** Clamped direct/diffuse radiation, or null when either value is missing/non-finite. */
export function getRadiationFeatures(rec: IrradianceRecord): RadiationFeatures | null {
  const direct = rec.directRadiation_W_per_m2;
  const diffuse = rec.diffuseRadiation_W_per_m2;
  if (direct == null || diffuse == null || !Number.isFinite(direct) || !Number.isFinite(diffuse)) return null;
  return {
    direct: Math.max(0, direct),
    diffuse: Math.max(0, diffuse),
  };
}

/**
 * Return the slot index (0-95) for a given UTC timestamp.
 * slot = hour * 4 + floor(minute / 15)
 */
export function slotOfDay(timeMs: number): number {
  const d = new Date(timeMs);
  return d.getUTCHours() * 4 + Math.floor(d.getUTCMinutes() / 15);
}

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
