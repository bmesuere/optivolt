import type { EvConfig, EvSocTarget } from '../../lib/types.ts';
import type { EvScheduleEntry, Settings } from '../types.ts';
import { expandWeeklySchedule, weeklyScheduleEntries } from './ev-weekly-schedule.ts';

export interface BuildEvConfigOptions {
  /** Current home battery SoC (%), used to estimate when the ESS floor stops blocking grid charging. */
  essSoc_percent?: number;
}

/**
 * Convert an absolute datetime string to a half-open slot boundary relative to `startMs`:
 * the number of whole `stepSize_m` slots between now and the time. Returns 0 when the time is
 * absent, unparseable, or already in the past. Clamped to `T + 1` (just beyond the horizon).
 */
export function departureTimeToSlot(
  time: string,
  startMs: number,
  stepSize_m: number,
  T: number,
): number {
  const ms = new Date(time).getTime();
  if (!Number.isFinite(ms)) return 0;
  const slots = Math.floor((ms - startMs) / (stepSize_m * 60_000));
  if (slots <= 0) return 0;
  return Math.min(slots, T + 1);
}

/**
 * Resolve the EV charging configuration from settings + a list of schedule entries + live state
 * into an availability map (windows the car can charge in) and SoC deadlines.
 *
 * Entries are typed events: `arrival` opens availability, `departure` closes it, `target` is a
 * pure SoC deadline (a `departure` may also carry an optional SoC = target at departure), and
 * `trip` is a departure + arrival pair with an optional usage estimate. The builder sweeps
 * open/close events in time order — starting available iff the car is plugged in — to produce N
 * windows (e.g. plugged in now, leaves, returns later → two windows).
 *
 * A trip's post-arrival window carries `drop_Wh` (= the usage estimate) instead of a fixed
 * `resetSoc_Wh`: the LP subtracts the drop from the pre-departure SoC, which stays a solver
 * decision, so charging before departure carries through the trip. Fixing the arrival SoC up
 * front would both misstate the return SoC and remove the incentive to charge before leaving.
 * A trip with a usage estimate also derives a departure target of usage + evTripSocBuffer.
 * The drop is clamped to the maximum SoC reachable by departure so the plan stays feasible.
 * Trips that touch or overlap in time are merged into a single away interval carrying the sum
 * of their drops (the car never plugs in between them).
 *
 * Entries beyond the horizon are ignored here; they remain persisted so they take effect once
 * the horizon reaches them. Past-due entries that survived normalization (an overdue departure
 * with the car still plugged in, an overdue arrival with the car still away) are treated as
 * happening at the next slot boundary, so an overdue departure keeps charging toward its target.
 *
 * A recurring weekly schedule (`settings.evWeeklySchedule`) is expanded into transient
 * arrival/departure entries for the windows inside the horizon (see ev-weekly-schedule.ts), and
 * into a per-slot `chargeAllowed` mask: with a weekly schedule the EV only charges inside its
 * windows. `settings.evEssSocFloor_percent` becomes `essSocFloor_Wh` (PV-only EV charging while
 * the home battery is below it).
 *
 * Returns the same `EvConfig` shape regardless of how many entries there are, so `build-lp.ts`
 * is unaffected. Returns `undefined` when the EV should not be modelled (disabled; away with no
 * future arrival; no usable SoC; or no windows).
 */
export function buildEvConfig(
  settings: Settings,
  entries: EvScheduleEntry[],
  evState: { pluggedIn: boolean; soc_percent: number } | undefined,
  nowMs: number,
  T: number,
  opts: BuildEvConfigOptions = {},
): EvConfig | undefined {
  if (!settings.evEnabled) return undefined;

  const pluggedIn = evState?.pluggedIn ?? false;
  const toSlot = (time: string) => departureTimeToSlot(time, nowMs, settings.stepSize_m, T);
  // Past-due entries that survived normalization are "imminent": clamp to the next slot boundary.
  const toBoundary = (time: string) => Math.max(1, toSlot(time));

  // --- Weekly schedule: transient entries + charging mask ---
  // A plan with no weekday selected is inactive and must not restrict charging.
  const weekly = (settings.evWeeklySchedule ?? []).filter((s) => s.weekdays.length > 0);
  let chargeAllowed: boolean[] | undefined;
  const essTargets: { slot: number; soc_Wh: number }[] = [];
  let allEntries = entries ?? [];
  if (weekly.length > 0) {
    const horizonEndMs = nowMs + T * settings.stepSize_m * 60_000;
    const occurrences = expandWeeklySchedule(weekly, nowMs, horizonEndMs);
    allEntries = [...allEntries, ...weeklyScheduleEntries(occurrences, nowMs)];
    chargeAllowed = Array(T).fill(false);
    for (const o of occurrences) {
      const from = toSlot(new Date(o.startMs).toISOString());
      const to = Math.min(T, toSlot(new Date(o.endMs).toISOString()));
      for (let t = from; t < to; t++) chargeAllowed[t] = true;
      // The home battery should be stocked by the time the window opens.
      if (from >= 1 && from < T) {
        essTargets.push({ slot: from - 1, soc_Wh: (o.ess_soc_percent / 100) * settings.batteryCapacity_Wh });
      }
    }
  }
  // A deadline the user entered (target, trip, departure with a SoC) keeps the whole plan
  // deadline-driven so that trip is not missed; weekly plans alone charge from the cheapest source.
  const hasManualDeadline = (entries ?? []).some((e) =>
    e.type === 'target' || e.type === 'trip' || (e.type === 'departure' && Number.isFinite(e.soc_percent)));
  const cheapestSource = settings.evWeeklyCheapestSource === true && weekly.length > 0 && !hasManualDeadline;

  // --- Map entries to open/close events and deadline requests (skipping beyond-horizon ones) ---
  type SweepEvent = { slot: number; kind: 'open' | 'close'; soc_percent?: number; drop_percent?: number };
  const events: SweepEvent[] = [];
  type TripInterval = { dep: number; arr: number; drop_percent: number };
  const tripIntervals: TripInterval[] = [];
  type TargetRequest = { boundary: number; soc_percent: number };
  const targetRequests: TargetRequest[] = [];
  const tripBuffer_percent = settings.evTripSocBuffer_percent ?? 0;

  for (const e of allEntries) {
    if (e.type === 'arrival') {
      const boundary = toBoundary(e.time);
      if (boundary <= T) events.push({ slot: boundary, kind: 'open', soc_percent: e.soc_percent });
    } else if (e.type === 'departure') {
      const boundary = toBoundary(e.time);
      if (boundary > T) continue;
      events.push({ slot: boundary, kind: 'close' });
      if (Number.isFinite(e.soc_percent)) targetRequests.push({ boundary, soc_percent: e.soc_percent as number });
    } else if (e.type === 'target') {
      const boundary = toSlot(e.time);
      if (boundary > 0 && boundary <= T && Number.isFinite(e.soc_percent)) {
        targetRequests.push({ boundary, soc_percent: e.soc_percent as number });
      }
    } else if (e.type === 'trip') {
      const dep = toBoundary(e.time);
      if (dep > T) continue; // entirely beyond the horizon
      // A trip shorter than one slot still needs a departure/arrival ordering; stretch to one slot.
      const arr = Math.max(toSlot(e.endTime ?? ''), dep + 1);
      tripIntervals.push({ dep, arr, drop_percent: e.usage_percent ?? 0 });
      if (e.usage_percent != null) {
        targetRequests.push({ boundary: dep, soc_percent: Math.min(100, e.usage_percent + tripBuffer_percent) });
      }
    }
  }

  // Merge touching/overlapping trips into one away interval with the summed drop before emitting
  // sweep events. Two trips sharing a boundary (return 14:00, leave again 14:00) would otherwise
  // race in the sweep: the second departure lands while the sweep is already closed (a no-op) and
  // the first return would reopen availability mid-trip carrying only the first drop. Summing is
  // exact for chained trips and conservative for genuinely overlapping (contradictory) ones.
  tripIntervals.sort((a, b) => a.dep - b.dep);
  const mergedTrips: TripInterval[] = [];
  for (const t of tripIntervals) {
    const last = mergedTrips[mergedTrips.length - 1];
    if (last && t.dep <= last.arr) {
      last.arr = Math.max(last.arr, t.arr);
      last.drop_percent += t.drop_percent;
    } else {
      mergedTrips.push({ ...t });
    }
  }
  for (const t of mergedTrips) {
    events.push({ slot: t.dep, kind: 'close' });
    if (t.arr <= T) events.push({ slot: t.arr, kind: 'open', drop_percent: t.drop_percent });
  }
  events.sort((x, y) => x.slot - y.slot || (x.kind === 'close' ? -1 : 1)); // close before open at a tie

  // --- Initial SoC ---
  const firstOpen = events.find(ev => ev.kind === 'open');
  let initialSoc_percent: number | undefined;
  if (pluggedIn) {
    initialSoc_percent = evState?.soc_percent;
  } else if (firstOpen) {
    initialSoc_percent = Number.isFinite(firstOpen.soc_percent)
      ? firstOpen.soc_percent
      : (evState && Number.isFinite(evState.soc_percent) ? evState.soc_percent : undefined);
  } else {
    return undefined; // away and not expected to arrive within the horizon
  }
  if (initialSoc_percent == null || !Number.isFinite(initialSoc_percent)) {
    console.warn('EV expected but no arrival SoC available (no entry SoC and no sensor reading); skipping EV modeling.');
    return undefined;
  }

  const minPow_W = settings.evMinChargeCurrent_A * 230;
  const maxPow_W = settings.evMaxChargeCurrent_A * 230;
  const capacityWh = settings.evBatteryCapacity_kWh * 1000;
  const stepHours = settings.stepSize_m / 60;
  const efficiency = settings.evChargeEfficiency_percent / 100;
  const socToWh = (soc: number) => (soc / 100) * capacityWh;
  const initialWh = socToWh(initialSoc_percent);
  // SoC to assume when a window opens without its own arrival SoC: the live sensor reading, else
  // the initial SoC (treats an untyped away gap as round-trip-neutral).
  const fallbackResetWh = evState && Number.isFinite(evState.soc_percent) ? socToWh(evState.soc_percent) : initialWh;

  // --- Window sweep ---
  // A window anchors its SoC in one of three ways: `resetSoc_Wh` (fixed arrival SoC),
  // `drop_Wh` (a trip return: pre-departure SoC minus the usage), or neither (the SoC simply
  // carries through the away gap — a zero-usage trip).
  type Window = { startSlot: number; endSlot: number; resetSoc_Wh?: number; drop_Wh?: number };
  const windows: Window[] = [];
  let open: Omit<Window, 'endSlot'> | null = pluggedIn
    ? { startSlot: 0, resetSoc_Wh: initialWh }
    : null;
  for (const ev of events) {
    if (ev.kind === 'open') {
      if (open != null) continue; // already available → arrival is a no-op
      if (ev.drop_percent != null) {
        const dropWh = socToWh(ev.drop_percent);
        open = { startSlot: ev.slot, ...(dropWh > 0 ? { drop_Wh: dropWh } : {}) };
      } else {
        const resetWh = Number.isFinite(ev.soc_percent) ? socToWh(ev.soc_percent as number) : fallbackResetWh;
        open = { startSlot: ev.slot, resetSoc_Wh: resetWh };
      }
    } else {
      if (open == null) continue; // already away → departure is a no-op
      if (ev.slot > open.startSlot) windows.push({ ...open, endSlot: ev.slot });
      open = null;
    }
  }
  if (open != null && T > open.startSlot) windows.push({ ...open, endSlot: T });
  if (windows.length === 0) return undefined;

  // --- Achievability forward pass ---
  // Track the maximum reachable SoC through the window chain. Used to (a) clamp each trip's
  // drop_Wh to what the car can possibly hold at departure — an unclamped drop would make the
  // LP infeasible via ev_soc >= 0 when the trip cannot be charged for in time — and (b) clamp
  // targets in post-trip windows, whose floor is not a fixed reset.
  const chargeablePerSlot_Wh = maxPow_W * stepHours * efficiency;

  // Slots that can realistically charge at full power: inside the weekly mask, and — when the home
  // battery starts below the ESS floor — after the battery could have been grid-charged back up
  // to it (until then only PV may charge the EV, which is conservatively not counted).
  const essFloor_percent = settings.evEssSocFloor_percent ?? 0;
  let floorDelaySlots = 0;
  const essSoc = opts.essSoc_percent;
  if (essFloor_percent > 0 && essSoc != null && Number.isFinite(essSoc) && essSoc < essFloor_percent) {
    const deficit_Wh = ((essFloor_percent - essSoc) / 100) * settings.batteryCapacity_Wh;
    const refill_W = Math.min(settings.maxChargePower_W, settings.maxGridImport_W);
    const refillPerSlot_Wh = refill_W * stepHours * (settings.chargeEfficiency_percent / 100);
    floorDelaySlots = refillPerSlot_Wh > 0 ? Math.ceil(deficit_Wh / refillPerSlot_Wh) : T;
  }
  const chargeableSlots = (from: number, to: number): number => {
    let n = 0;
    for (let t = Math.max(from, floorDelaySlots); t < to; t++) if (!chargeAllowed || chargeAllowed[t]) n++;
    return n;
  };
  const maxStartByWindow = new Map<Window, number>();
  let maxCarried_Wh = initialWh; // max achievable SoC carried into the next window (flat in gaps)
  for (const w of windows) {
    let maxStart: number;
    if (w.resetSoc_Wh != null) {
      maxStart = w.resetSoc_Wh;
    } else {
      if (w.drop_Wh != null) {
        w.drop_Wh = Math.min(w.drop_Wh, maxCarried_Wh);
        if (w.drop_Wh <= 0) delete w.drop_Wh;
      }
      maxStart = Math.max(0, maxCarried_Wh - (w.drop_Wh ?? 0));
    }
    maxStartByWindow.set(w, maxStart);
    maxCarried_Wh = Math.min(capacityWh, maxStart + chargeablePerSlot_Wh * chargeableSlots(w.startSlot, w.endSlot));
  }

  // --- Targets ---
  const targets: EvSocTarget[] = [];
  // Locate the window a deadline belongs to, clamping deadlines in a gap (or after the last
  // window) back to the preceding window end — a target can only be met while charging.
  const locate = (boundary: number): { window: Window; clampedBoundary: number } | null => {
    let lastBefore: Window | null = null;
    for (const w of windows) {
      if (boundary <= w.startSlot) break;
      if (boundary <= w.endSlot) return { window: w, clampedBoundary: boundary };
      lastBefore = w;
    }
    return lastBefore ? { window: lastBefore, clampedBoundary: lastBefore.endSlot } : null;
  };
  const addTarget = (boundary: number, requestedSoc_percent: number): void => {
    if (boundary <= 0 || !Number.isFinite(requestedSoc_percent)) return;
    const loc = locate(boundary);
    if (!loc) return;
    const { window, clampedBoundary } = loc;
    const targetSlot = clampedBoundary - 1;
    if (targetSlot < window.startSlot) return;
    const requestedWh = socToWh(requestedSoc_percent);
    const chargingSlots = chargeableSlots(window.startSlot, clampedBoundary);
    const maxStartSoc_Wh = maxStartByWindow.get(window) ?? window.resetSoc_Wh ?? 0;
    const achievableWh = Math.min(requestedWh, maxStartSoc_Wh + chargeablePerSlot_Wh * chargingSlots, capacityWh);
    // A fixed reset already at/above the target makes it redundant; a chained (post-trip) window
    // has no guaranteed floor, so its targets are always kept.
    if (achievableWh <= 0 || (window.resetSoc_Wh != null && achievableWh <= window.resetSoc_Wh)) return;
    targets.push({ slot: targetSlot, soc_Wh: achievableWh });
  };

  for (const tr of targetRequests) addTarget(tr.boundary, tr.soc_percent);

  // De-dupe targets landing on the same slot, keeping the higher requirement.
  const bySlot = new Map<number, number>();
  for (const tg of targets) bySlot.set(tg.slot, Math.max(bySlot.get(tg.slot) ?? 0, tg.soc_Wh));
  const dedupedTargets = [...bySlot.entries()]
    .map(([slot, soc_Wh]) => ({ slot, soc_Wh }))
    .sort((a, b) => a.slot - b.slot);

  return {
    evMinChargePower_W: Math.min(minPow_W, maxPow_W),
    evMaxChargePower_W: maxPow_W,
    evBatteryCapacity_Wh: capacityWh,
    evInitialSoc_percent: initialSoc_percent,
    evChargeEfficiency_percent: settings.evChargeEfficiency_percent,
    evMaxSoc_percent: settings.evMaxSoc_percent ?? 100,
    availabilityWindows: windows,
    targets: dedupedTargets,
    ...(chargeAllowed ? { chargeAllowed } : {}),
    ...(cheapestSource ? { cheapestSource, essTargets } : {}),
    ...(essFloor_percent > 0 ? { essSocFloor_Wh: (essFloor_percent / 100) * settings.batteryCapacity_Wh } : {}),
  };
}
