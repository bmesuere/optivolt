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
 * All UTC instants whose FEED_TZ wall-clock rendering matches the given wall
 * time (passed as its components read as UTC). Ascending; 0, 1, or 2 results:
 * a normal time yields one, the repeated hour at the autumn DST transition
 * yields two, and a nonexistent spring-forward time yields none.
 */
function wallTimeToUtcCandidates(wallAsUtc: number): number[] {
  // The zone's offsets on either side of a possible transition near this time.
  const probeOffsets = new Set([
    tzOffsetMs(wallAsUtc - 12 * 3_600_000),
    tzOffsetMs(wallAsUtc + 12 * 3_600_000),
  ]);
  const candidates = new Set<number>();
  for (const offset of probeOffsets) {
    const ts = wallAsUtc - offset;
    if (tzOffsetMs(ts) === offset) candidates.add(ts); // round-trips → real occurrence
  }
  return [...candidates].sort((a, b) => a - b);
}

/**
 * Parse a feed timestamp to every epoch-ms instant it can denote. Timestamps
 * with an explicit offset (or Z) are unambiguous; bare "YYYY-MM-DD HH:MM:SS"
 * strings are interpreted as Europe/Brussels wall-clock time, which is
 * ambiguous during the repeated hour at the autumn DST transition (both
 * occurrences are returned, ascending). Empty when unparseable.
 */
export function feedTimestampCandidates(value: string): number[] {
  if (typeof value !== 'string') return [];
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    const ts = new Date(value).getTime();
    return Number.isFinite(ts) ? [ts] : [];
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return [];
  const [y, mo, d, h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const candidates = wallTimeToUtcCandidates(wallAsUtc);
  if (candidates.length > 0) return candidates;
  // Nonexistent local time (spring-forward gap): best-effort single instant.
  return [wallAsUtc - tzOffsetMs(wallAsUtc)];
}

/** Parse a feed timestamp to epoch ms, taking the earlier occurrence when ambiguous. NaN when unparseable. */
export function parseFeedTimestamp(value: string): number {
  return feedTimestampCandidates(value)[0] ?? NaN;
}

/**
 * Convert a list of feed points into a contiguous 15-min TimeSeries.
 * Points are consumed in feed order; the series is truncated at the first
 * gap, out-of-order timestamp, or invalid price, so a malformed feed can
 * never fabricate prices. DST-ambiguous wall times resolve to whichever
 * occurrence continues the sequence, keeping the autumn repeated hour
 * contiguous.
 */
export function pointsToSeries(points: ForecastFeedPoint[]): TimeSeries | null {
  const stepMs = STEP_MINUTES * 60_000;
  const values: number[] = [];
  let startMs: number | null = null;
  let expectedMs: number = NaN;

  for (const p of points) {
    // Strict price check: JSON null / '' / booleans coerce to 0 via Number(),
    // which would read as free electricity — only accept real finite numbers.
    if (typeof p?.price !== 'number' || !Number.isFinite(p.price)) break;
    const candidates = feedTimestampCandidates(p?.time as string);
    if (candidates.length === 0) break;
    const timeMs: number = startMs == null
      ? candidates[0]
      : (candidates.includes(expectedMs) ? expectedMs : candidates[0]);
    if (startMs == null) {
      startMs = timeMs;
    } else if (timeMs !== expectedMs) {
      break;
    }
    values.push(p.price);
    expectedMs = timeMs + stepMs;
  }
  if (startMs == null || values.length === 0) return null;

  return {
    start: new Date(startMs).toISOString(),
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
