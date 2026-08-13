import { randomUUID } from 'node:crypto';
import { HttpError } from '../http-errors.ts';
import type { Data, EvScheduleEntry, EvScheduleEntryType } from '../types.ts';

export interface EvScheduleEntryInput {
  type?: unknown;
  time?: unknown;
  soc_percent?: unknown;
  endTime?: unknown;
  usage_percent?: unknown;
}

const TYPES = new Set<EvScheduleEntryType>(['arrival', 'departure', 'target', 'trip']);

function toTimestamp(value: string, field: string): number {
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) throw new HttpError(400, `${field} must be a valid timestamp`);
  return ts;
}

/**
 * Parse an optional percentage field with tri-state semantics: absent → keep the existing value,
 * present-but-empty (null/'') → cleared, otherwise a number in [0, 100].
 */
function parseOptionalPercent(raw: unknown, baseValue: number | undefined, field: string): number | undefined {
  const value = raw !== undefined ? raw : baseValue;
  if (value == null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new HttpError(400, `${field} must be a number in [0, 100]`);
  }
  return parsed;
}

/**
 * Parse and validate the user-supplied fields of an EV schedule entry. `soc_percent` is required
 * (in [0,100]) for a target, optional for arrival/departure and unused for a trip. A trip carries
 * a required `endTime` (the arrival, strictly after `time` = the departure) and an optional
 * `usage_percent` estimate. Unlike prediction adjustments, past times are allowed — entries
 * persist until pruned, so they can be entered in advance.
 */
function parseEntryFields(
  input: EvScheduleEntryInput,
  base?: EvScheduleEntry,
  _nowMs = Date.now(),
): Omit<EvScheduleEntry, 'id' | 'createdAt' | 'updatedAt'> {
  const type = (input.type ?? base?.type) as EvScheduleEntryType;
  if (!TYPES.has(type)) throw new HttpError(400, 'type must be "arrival", "departure", "target" or "trip"');

  const time = String(input.time ?? base?.time ?? '');
  const timeMs = toTimestamp(time, 'time');

  if (type === 'trip') {
    const endTime = String(input.endTime ?? base?.endTime ?? '');
    const endMs = toTimestamp(endTime, 'endTime');
    if (endMs <= timeMs) throw new HttpError(400, 'endTime (arrival) must be after time (departure)');
    const usage_percent = parseOptionalPercent(input.usage_percent, base?.usage_percent, 'usage_percent');
    return {
      type,
      time: new Date(timeMs).toISOString(),
      endTime: new Date(endMs).toISOString(),
      ...(usage_percent != null ? { usage_percent } : {}),
    };
  }

  // Distinguish "field absent" (keep the existing value) from "field present but empty"
  // (the user cleared it), so an edit can actually remove a previously-set soc_percent.
  const soc_percent = parseOptionalPercent(input.soc_percent, base?.soc_percent, 'soc_percent');
  if (soc_percent == null && type === 'target') {
    throw new HttpError(400, 'target entries require soc_percent in [0, 100]');
  }

  return {
    type,
    time: new Date(timeMs).toISOString(),
    ...(soc_percent != null ? { soc_percent } : {}),
  };
}

export function validateEvScheduleEntry(entry: EvScheduleEntry): void {
  parseEntryFields(entry, undefined, 0);
  if (!entry.id || typeof entry.id !== 'string') {
    throw new Error('Invalid evScheduleEntries: id must be a string');
  }
  if (Number.isNaN(new Date(entry.createdAt).getTime())) {
    throw new Error('Invalid evScheduleEntries: createdAt must be a valid timestamp');
  }
  if (Number.isNaN(new Date(entry.updatedAt).getTime())) {
    throw new Error('Invalid evScheduleEntries: updatedAt must be a valid timestamp');
  }
}

export function createEvScheduleEntry(input: EvScheduleEntryInput, nowMs = Date.now()): EvScheduleEntry {
  const nowIso = new Date(nowMs).toISOString();
  return {
    id: randomUUID(),
    ...parseEntryFields(input, undefined, nowMs),
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

export function updateEvScheduleEntry(
  existing: EvScheduleEntry,
  input: EvScheduleEntryInput,
  nowMs = Date.now(),
): EvScheduleEntry {
  // Take id/createdAt from the existing entry, but let parseEntryFields produce the full content
  // (type/time/soc_percent/endTime/usage_percent). Spreading `existing` wholesale would resurrect
  // a cleared soc_percent, or keep trip fields on an entry whose type was switched away from trip.
  return {
    id: existing.id,
    ...parseEntryFields(input, existing, nowMs),
    createdAt: existing.createdAt,
    updatedAt: new Date(nowMs).toISOString(),
  };
}

/**
 * Convert a trip whose departure has passed (and whose car has actually left) into a plain
 * arrival entry at the trip's arrival time, so the solver only ever models future trips with the
 * relative drop constraint; a departed trip becomes an ordinary reset the user can still tweak.
 * The expected arrival SoC is the last SoC observed while plugged in minus the trip usage; when
 * either is unknown the SoC is omitted, deferring to the live sensor (the existing arrival
 * fallback).
 */
function convertDepartedTrip(
  trip: EvScheduleEntry,
  socAtUnplug_percent: number | null,
  nowMs: number,
): EvScheduleEntry {
  const usage = trip.usage_percent;
  const soc_percent = usage != null && socAtUnplug_percent != null && Number.isFinite(socAtUnplug_percent)
    ? Math.max(0, Math.min(100, Math.round(socAtUnplug_percent - usage)))
    : undefined;
  return {
    id: trip.id,
    type: 'arrival',
    time: trip.endTime as string,
    ...(soc_percent != null ? { soc_percent } : {}),
    createdAt: trip.createdAt,
    updatedAt: new Date(nowMs).toISOString(),
  };
}

/**
 * Record the latest observed EV state into `data.evLastState`. `soc_percent` keeps the last SoC
 * seen while the car was plugged in: once it leaves, that reading is the best "SoC at unplug"
 * estimate for trip conversion, so an away/NaN reading must not overwrite it. Returns the input
 * `data` unchanged when there is nothing new to record (avoiding a disk write per solve).
 */
export function recordEvLastState(
  data: Data,
  evState: { pluggedIn: boolean; soc_percent: number } | undefined,
  nowMs = Date.now(),
): Data {
  if (!evState) return data;
  const prev = data.evLastState;
  const soc_percent = evState.pluggedIn && Number.isFinite(evState.soc_percent)
    ? evState.soc_percent
    : prev?.soc_percent ?? null;
  if (prev && prev.pluggedIn === evState.pluggedIn && prev.soc_percent === soc_percent) return data;
  return {
    ...data,
    evLastState: { pluggedIn: evState.pluggedIn, soc_percent, observedAt: new Date(nowMs).toISOString() },
  };
}

/**
 * Prune expired entries and convert departed trips, using the persisted plug state
 * (`data.evLastState`) to decide whether a past-due event has actually happened:
 *
 * - departure in the past, car still plugged in → kept ("overdue": it can still charge, and could
 *   leave any moment, so the departure target stays active).
 * - arrival in the past, car still away → kept (the arrival is imminent; its reset still applies
 *   when the car shows up).
 * - trip whose departure passed: still plugged in → kept as an overdue trip (unless its arrival
 *   also passed — then the trip never happened and is dropped); car gone → converted to an
 *   arrival entry (see convertDepartedTrip), which then follows the arrival rules above.
 * - target in the past → dropped.
 *
 * With no recorded plug state, past events are assumed to have happened (the pre-plug-state
 * behavior): past entries are pruned, and past trips are converted using no SoC estimate.
 */
export function normalizeEvScheduleEntries(
  data: Data,
  nowMs = Date.now(),
): { data: Data; changed: boolean; entries: EvScheduleEntry[] } {
  const entries = data.evScheduleEntries ?? [];
  const pluggedIn = data.evLastState?.pluggedIn;
  const socAtUnplug = data.evLastState?.soc_percent ?? null;

  let changed = false;
  const next: EvScheduleEntry[] = [];
  for (const entry of entries) {
    if (toTimestamp(entry.time, 'time') >= nowMs) { next.push(entry); continue; }

    if (entry.type === 'departure' && pluggedIn === true) { next.push(entry); continue; }
    if (entry.type === 'arrival' && pluggedIn === false) { next.push(entry); continue; }
    if (entry.type === 'trip') {
      const endMs = toTimestamp(entry.endTime ?? entry.time, 'endTime');
      if (pluggedIn === true) {
        // Still plugged past the departure: overdue trip, unless the arrival also passed —
        // then the trip never happened.
        if (endMs >= nowMs) { next.push(entry); continue; }
      } else {
        const arrival = convertDepartedTrip(entry, socAtUnplug, nowMs);
        // The converted arrival may itself already be past due; apply the arrival rule.
        if (endMs >= nowMs || pluggedIn === false) { next.push(arrival); changed = true; continue; }
      }
    }
    changed = true; // dropped
  }

  if (!changed) return { data, changed: false, entries };
  return { data: { ...data, evScheduleEntries: next }, changed: true, entries: next };
}
