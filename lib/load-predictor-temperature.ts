/**
 * load-predictor-temperature.ts
 *
 * Pure temperature-anchored load prediction, for loads driven by outside
 * temperature (e.g. a heat pump on a schedule).
 *
 * Algorithm overview:
 *   1. Summarize each historical day as an effective temperature (inertia-
 *      weighted mean over the last 3 days) and its per-hour load values.
 *   2. Per day bucket (getDayBucket), sort days by effective temperature and
 *      cut them into quantile bins; each bin becomes an anchor: its median
 *      temperature plus a median load profile per hour.
 *   3. Predict a target hour by piecewise-linear interpolation between the
 *      two anchors bracketing the target day's effective temperature
 *      (extrapolating along the outermost segment for unseen temperatures).
 *
 * Like the PV predictors, this is stateless: anchors are rebuilt from raw
 * history on every forecast run — nothing is fitted or persisted.
 */

import type { StatRecord } from './ha-postprocess.ts';
import type { PredictionResult } from './time-series-utils.ts';
import { getDayBucket, median, type DayFilter } from './load-predictor-historical.ts';

export interface TemperatureRecord {
  time: number;    // ms epoch, start of the hour
  temp_C: number;
}

export interface TemperaturePredictConfig {
  sensor: string;
  lookbackWeeks: number;
  dayFilter: DayFilter;
  bins: number;
}

export interface TemperatureAnchor {
  temp_C: number;
  /** Median load per UTC hour (same unit as the input records, Wh/h ≈ W). */
  profile: (number | null)[];
  dayCount: number;
}

export interface TemperatureModel {
  /** Anchors per day bucket; a bucket without enough days is absent. */
  buckets: Map<string | number, TemperatureAnchor[]>;
  /** Anchors over all days, used when a bucket is absent. */
  pooled: TemperatureAnchor[];
}

/** Thermal inertia: today weighs 4/7, yesterday 2/7, the day before 1/7. */
const INERTIA_WEIGHTS = [4 / 7, 2 / 7, 1 / 7];

/** A bin needs at least this many days to make a stable anchor. */
const MIN_DAYS_PER_BIN = 4;

/** A day needs at least this many hourly readings to count as observed. */
const MIN_HOURS_PER_DAY = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC day key ('YYYY-MM-DD') for an epoch-ms timestamp. */
export function dayKey(timeMs: number): string {
  return new Date(timeMs).toISOString().slice(0, 10);
}

/**
 * Mean temperature per UTC day from hourly records.
 */
export function computeDayMeanTemps(temps: TemperatureRecord[]): Map<string, number> {
  const sums = new Map<string, { sum: number; n: number }>();
  for (const t of temps) {
    if (!Number.isFinite(t.temp_C)) continue;
    const key = dayKey(t.time);
    const entry = sums.get(key) ?? { sum: 0, n: 0 };
    entry.sum += t.temp_C;
    entry.n += 1;
    sums.set(key, entry);
  }
  const means = new Map<string, number>();
  for (const [key, { sum, n }] of sums) means.set(key, sum / n);
  return means;
}

/**
 * Inertia-weighted effective temperature per day: 4:2:1 blend of the day and
 * the two days before it, renormalized over the days actually available.
 */
export function computeEffectiveDayTemps(dayMeans: Map<string, number>): Map<string, number> {
  const eff = new Map<string, number>();
  for (const key of dayMeans.keys()) {
    const dayStart = new Date(key + 'T00:00:00Z').getTime();
    let sum = 0;
    let weight = 0;
    for (let k = 0; k < INERTIA_WEIGHTS.length; k++) {
      const mean = dayMeans.get(dayKey(dayStart - k * DAY_MS));
      if (mean === undefined) continue;
      sum += INERTIA_WEIGHTS[k] * mean;
      weight += INERTIA_WEIGHTS[k];
    }
    if (weight > 0) eff.set(key, sum / weight);
  }
  return eff;
}

interface DaySummary {
  dayOfWeek: number;
  effTemp_C: number;
  /** Load per UTC hour; null where the hour is missing. */
  hours: (number | null)[];
  hourCount: number;
}

/**
 * Build temperature anchors from load history and effective day temperatures.
 * Only full days strictly before `nowMs` and within the lookback window count.
 */
export function buildTemperatureAnchors(
  data: StatRecord[],
  effTemps: Map<string, number>,
  { sensor, lookbackWeeks, dayFilter, bins }: TemperaturePredictConfig,
  nowMs: number,
): TemperatureModel {
  const todayKey = dayKey(nowMs);
  const earliestMs = nowMs - lookbackWeeks * 7 * DAY_MS;

  const days = new Map<string, DaySummary>();
  for (const rec of data) {
    if (rec.sensor !== sensor) continue;
    if (rec.time < earliestMs) continue;
    const key = dayKey(rec.time);
    if (key >= todayKey) continue; // exclude today's partial day
    const effTemp = effTemps.get(key);
    if (effTemp === undefined) continue;

    let day = days.get(key);
    if (!day) {
      day = { dayOfWeek: rec.dayOfWeek, effTemp_C: effTemp, hours: Array(24).fill(null), hourCount: 0 };
      days.set(key, day);
    }
    if (day.hours[rec.hour] === null) day.hourCount += 1;
    day.hours[rec.hour] = (day.hours[rec.hour] ?? 0) + rec.value;
  }

  const usable = [...days.values()].filter(d => d.hourCount >= MIN_HOURS_PER_DAY);

  const byBucket = new Map<string | number, DaySummary[]>();
  for (const day of usable) {
    const bucket = getDayBucket(day.dayOfWeek, dayFilter);
    if (!byBucket.has(bucket)) byBucket.set(bucket, []);
    byBucket.get(bucket)!.push(day);
  }

  const buckets = new Map<string | number, TemperatureAnchor[]>();
  for (const [bucket, bucketDays] of byBucket) {
    const anchors = binIntoAnchors(bucketDays, bins);
    if (anchors.length > 0) buckets.set(bucket, anchors);
  }

  return { buckets, pooled: binIntoAnchors(usable, bins) };
}

function binIntoAnchors(days: DaySummary[], bins: number): TemperatureAnchor[] {
  const nBins = Math.min(bins, Math.floor(days.length / MIN_DAYS_PER_BIN));
  if (nBins < 1) return [];

  const sorted = [...days].sort((a, b) => a.effTemp_C - b.effTemp_C);
  const anchors: TemperatureAnchor[] = [];
  for (let b = 0; b < nBins; b++) {
    const start = Math.floor((b * sorted.length) / nBins);
    const end = Math.floor(((b + 1) * sorted.length) / nBins);
    const binDays = sorted.slice(start, end);

    const profile: (number | null)[] = [];
    for (let h = 0; h < 24; h++) {
      const values = binDays.map(d => d.hours[h]).filter((v): v is number => v !== null);
      profile.push(values.length > 0 ? median(values) : null);
    }

    anchors.push({
      temp_C: median(binDays.map(d => d.effTemp_C)),
      profile,
      dayCount: binDays.length,
    });
  }
  return anchors;
}

/**
 * Predicted load for one UTC hour on a day with the given effective
 * temperature, interpolating between the bracketing anchors. Extrapolation
 * beyond the outermost anchors follows the outermost segment, with the
 * temperature clamped to half the anchor span beyond the extremes so a
 * freak forecast cannot run the line off to absurd values, and the result
 * floored at the lowest anchor value for the hour — devices keep a small
 * idle draw at mild temperatures, so extrapolation flattens out there
 * instead of running down to 0.
 */
export function predictHourFromAnchors(
  anchors: TemperatureAnchor[],
  effTemp_C: number,
  hour: number,
): number | null {
  if (anchors.length === 0) return null;
  const first = anchors[0];
  const last = anchors[anchors.length - 1];

  let floor_W = Infinity;
  for (const anchor of anchors) {
    const value = anchor.profile[hour];
    if (value !== null && value < floor_W) floor_W = value;
  }
  floor_W = floor_W === Infinity ? 0 : Math.max(0, floor_W);

  if (anchors.length === 1) return clampToFloor(first.profile[hour], floor_W);

  const span = last.temp_C - first.temp_C;
  const t = Math.min(Math.max(effTemp_C, first.temp_C - span / 2), last.temp_C + span / 2);

  // Find the segment to interpolate on; outside the anchor range, the
  // outermost segment extends linearly.
  let lo = first;
  let hi = anchors[1];
  for (let i = 1; i < anchors.length; i++) {
    if (anchors[i].temp_C >= t || i === anchors.length - 1) {
      lo = anchors[i - 1];
      hi = anchors[i];
      break;
    }
  }

  const loVal = lo.profile[hour];
  const hiVal = hi.profile[hour];
  if (loVal === null || hiVal === null) return clampToFloor(loVal ?? hiVal, floor_W);

  const dt = hi.temp_C - lo.temp_C;
  if (Math.abs(dt) < 0.5) return clampToFloor((loVal + hiVal) / 2, floor_W);

  const frac = (t - lo.temp_C) / dt;
  return clampToFloor(loVal + frac * (hiVal - loVal), floor_W);
}

function clampToFloor(value: number | null, floor_W: number): number | null {
  return value === null ? null : Math.max(floor_W, value);
}

/**
 * Generate all temperature-predictor configurations to evaluate in a
 * validation run, mirroring generateAllConfigs() for historical predictors.
 * The lookbacks stay within the 8-week validation data fetch.
 */
export function generateTemperatureConfigs(
  sensorNames: string[],
  lookbacks: number[] = [2, 4, 6, 8],
  dayFilters: DayFilter[] = ['same', 'all', 'weekday-weekend', 'weekday-sat-sun'],
  binCounts: number[] = [2, 3, 4, 6],
): TemperaturePredictConfig[] {
  const configs: TemperaturePredictConfig[] = [];
  for (const sensor of sensorNames) {
    for (const lookbackWeeks of lookbacks) {
      for (const dayFilter of dayFilters) {
        for (const bins of binCounts) {
          configs.push({ sensor, lookbackWeeks, dayFilter, bins });
        }
      }
    }
  }
  return configs;
}

/**
 * Compute predictions for target hours, mirroring the historical predictor's
 * predict() shape so results feed the same summing machinery.
 */
export function predictTemperatureLoad(
  model: TemperatureModel,
  dayFilter: DayFilter,
  targets: Array<Pick<StatRecord, 'date' | 'time' | 'hour' | 'dayOfWeek'> & { value?: number | null }>,
  effTemps: Map<string, number>,
): PredictionResult[] {
  return targets.map(target => {
    const effTemp = effTemps.get(dayKey(target.time));
    let predicted: number | null = null;
    if (effTemp !== undefined) {
      const bucket = getDayBucket(target.dayOfWeek, dayFilter);
      const anchors = model.buckets.get(bucket) ?? model.pooled;
      predicted = predictHourFromAnchors(anchors, effTemp, target.hour);
    }
    return {
      date: target.date,
      time: target.time,
      hour: target.hour,
      actual: target.value ?? null,
      predicted,
    };
  });
}
