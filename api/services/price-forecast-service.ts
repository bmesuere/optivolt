/**
 * price-forecast-service.ts
 *
 * Pulls forecast prices from a configured URL (the energieprijs forecast.json
 * format: EpexPredictor predictions with supplier formulas applied) and
 * persists them as data.importPriceForecast / data.exportPriceForecast.
 *
 * These series never replace actual prices — config-builder only uses them to
 * extend the tail of the actual price series when the extended horizon is on.
 */

import { fetchWithTimeout } from '../../lib/fetch-utils.ts';
import { loadSettings } from './settings-store.ts';
import { loadData, saveData } from './data-store.ts';
import type { TimeSeries } from '../types.ts';

const PRICE_FORECAST_TIMEOUT_MS = 15000;
const FEED_TZ = 'Europe/Brussels';
const STEP_MINUTES = 15;

interface ForecastFeedPoint {
  time: string;
  price: number;
}

interface ForecastFeed {
  consumption_data?: ForecastFeedPoint[];
  injection_data?: ForecastFeedPoint[];
  known_until?: string;
}

const tzFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: FEED_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
});

/** UTC offset of FEED_TZ at the given instant, in ms. */
function tzOffsetMs(utcMs: number): number {
  const parts = tzFormatter.formatToParts(utcMs);
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? NaN);
  const wallAsUtc = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    get('hour') % 24, get('minute'), get('second'),
  );
  return wallAsUtc - utcMs;
}

/**
 * Parse a feed timestamp to epoch ms. Timestamps with an explicit offset (or
 * Z) are parsed directly; bare "YYYY-MM-DD HH:MM:SS" strings are interpreted
 * as Europe/Brussels wall-clock time.
 */
export function parseFeedTimestamp(value: string): number {
  if (typeof value !== 'string') return NaN;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    return new Date(value).getTime();
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return NaN;
  const [y, mo, d, h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  // Wall-clock → UTC: guess the offset at the wall time read as UTC, then
  // re-evaluate once at the corrected instant. This converges except inside a
  // DST transition, where either candidate is at most an hour off.
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  let ts = wallAsUtc - tzOffsetMs(wallAsUtc);
  ts = wallAsUtc - tzOffsetMs(ts);
  return ts;
}

/**
 * Convert a list of feed points into a contiguous 15-min TimeSeries.
 * Points are sorted by time; the series is truncated at the first gap or
 * non-finite value so a malformed feed can never fabricate prices.
 */
export function pointsToSeries(points: ForecastFeedPoint[]): TimeSeries | null {
  const stepMs = STEP_MINUTES * 60_000;
  const parsed = points
    .map(p => ({ timeMs: parseFeedTimestamp(p.time), price: Number(p.price) }))
    .filter(p => Number.isFinite(p.timeMs))
    .sort((a, b) => a.timeMs - b.timeMs);
  if (parsed.length === 0) return null;

  const values: number[] = [];
  let expectedMs = parsed[0].timeMs;
  for (const p of parsed) {
    if (p.timeMs !== expectedMs || !Number.isFinite(p.price)) break;
    values.push(p.price);
    expectedMs += stepMs;
  }
  if (values.length === 0) return null;

  return {
    start: new Date(parsed[0].timeMs).toISOString(),
    step: STEP_MINUTES,
    values,
  };
}

export interface ParsedPriceForecast {
  importPriceForecast: TimeSeries;
  exportPriceForecast: TimeSeries;
  knownUntilMs: number | null;
}

/** Parse the forecast.json payload; throws when it contains no usable series. */
export function parsePriceForecastFeed(feed: ForecastFeed): ParsedPriceForecast {
  const importPriceForecast = pointsToSeries(feed.consumption_data ?? []);
  const exportPriceForecast = pointsToSeries(feed.injection_data ?? []);
  if (!importPriceForecast || !exportPriceForecast) {
    throw new Error('Price forecast feed contains no usable consumption/injection series');
  }
  const knownUntilMs = feed.known_until != null ? parseFeedTimestamp(feed.known_until) : NaN;
  return {
    importPriceForecast,
    exportPriceForecast,
    knownUntilMs: Number.isFinite(knownUntilMs) ? knownUntilMs : null,
  };
}

/**
 * Fetch the configured price-forecast feed and persist the parsed series.
 * No-op unless the extended horizon is enabled and a URL is configured.
 * On failure the previously stored forecast is kept (and simply ages out).
 */
export async function refreshPriceForecastAndPersist(): Promise<void> {
  const settings = await loadSettings();
  if (settings.extendedHorizonDays <= 0 || !settings.priceForecastUrl) return;

  const response = await fetchWithTimeout(
    settings.priceForecastUrl,
    {},
    { timeoutMs: PRICE_FORECAST_TIMEOUT_MS, label: 'Price forecast request' },
  );
  if (!response.ok) {
    throw new Error(`Price forecast feed returned status ${response.status}`);
  }

  const parsed = parsePriceForecastFeed(await response.json() as ForecastFeed);

  const data = await loadData();
  data.importPriceForecast = parsed.importPriceForecast;
  data.exportPriceForecast = parsed.exportPriceForecast;
  await saveData(data);

  console.log('[price-forecast] refreshed', {
    start: parsed.importPriceForecast.start,
    slots: parsed.importPriceForecast.values.length,
    knownUntil: parsed.knownUntilMs != null ? new Date(parsed.knownUntilMs).toISOString() : null,
  });
}
