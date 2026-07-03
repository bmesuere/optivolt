import type { EvConfig, EvSocTarget } from '../../lib/types.ts';
import type { EvScheduleEntry, Settings } from '../types.ts';

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
 * pure SoC deadline (a `departure` may also carry an optional SoC = target at departure). The
 * builder sweeps arrival/departure events in time order — starting available iff the car is
 * plugged in — to produce N windows (e.g. plugged in now, leaves, returns later → two windows).
 * Entries in the past or beyond the horizon are ignored here (current presence comes from the
 * plug sensor); they remain persisted so they take effect once the horizon reaches them.
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
): EvConfig | undefined {
  if (!settings.evEnabled) return undefined;

  const pluggedIn = evState?.pluggedIn ?? false;
  const toSlot = (time: string) => departureTimeToSlot(time, nowMs, settings.stepSize_m, T);

  // Map entries to in-horizon slot boundaries; drop past (boundary 0) and beyond-horizon (> T).
  const mapped = (entries ?? [])
    .map(e => ({ type: e.type, boundary: toSlot(e.time), soc_percent: e.soc_percent }))
    .filter(e => e.boundary > 0 && e.boundary <= T);
  const arrivals = mapped.filter(e => e.type === 'arrival').sort((a, b) => a.boundary - b.boundary);
  const departures = mapped.filter(e => e.type === 'departure').sort((a, b) => a.boundary - b.boundary);

  // --- Initial SoC ---
  const firstArrival = arrivals[0];
  let initialSoc_percent: number | undefined;
  if (pluggedIn) {
    initialSoc_percent = evState?.soc_percent;
  } else if (firstArrival) {
    initialSoc_percent = Number.isFinite(firstArrival.soc_percent)
      ? firstArrival.soc_percent
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
  // the initial SoC (treats a trip as round-trip-neutral when we have no better information).
  const fallbackResetWh = evState && Number.isFinite(evState.soc_percent) ? socToWh(evState.soc_percent) : initialWh;

  // --- Window sweep ---
  type Window = { startSlot: number; endSlot: number; resetSoc_Wh: number };
  const events = [
    ...arrivals.map(a => ({ slot: a.boundary, kind: 'open' as const, soc: a.soc_percent })),
    ...departures.map(d => ({ slot: d.boundary, kind: 'close' as const })),
  ].sort((x, y) => x.slot - y.slot || (x.kind === 'close' ? -1 : 1)); // close before open at a tie

  const windows: Window[] = [];
  let open: { startSlot: number; resetSoc_Wh: number } | null = pluggedIn
    ? { startSlot: 0, resetSoc_Wh: initialWh }
    : null;
  for (const ev of events) {
    if (ev.kind === 'open') {
      if (open != null) continue; // already available → arrival is a no-op
      const resetWh = Number.isFinite(ev.soc) ? socToWh(ev.soc as number) : fallbackResetWh;
      open = { startSlot: ev.slot, resetSoc_Wh: resetWh };
    } else {
      if (open == null) continue; // already away → departure is a no-op
      if (ev.slot > open.startSlot) windows.push({ ...open, endSlot: ev.slot });
      open = null;
    }
  }
  if (open != null && T > open.startSlot) windows.push({ ...open, endSlot: T });
  if (windows.length === 0) return undefined;

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
  const addTarget = (boundary: number, requestedSoc_percent?: number): void => {
    if (boundary <= 0 || !Number.isFinite(requestedSoc_percent)) return;
    const loc = locate(boundary);
    if (!loc) return;
    const { window, clampedBoundary } = loc;
    const targetSlot = clampedBoundary - 1;
    if (targetSlot < window.startSlot) return;
    const requestedWh = socToWh(requestedSoc_percent as number);
    const chargingSlots = Math.max(0, clampedBoundary - window.startSlot);
    const maxChargeable_Wh = maxPow_W * stepHours * chargingSlots * efficiency;
    const achievableWh = Math.min(requestedWh, window.resetSoc_Wh + maxChargeable_Wh, capacityWh);
    if (achievableWh <= window.resetSoc_Wh) return;
    targets.push({ slot: targetSlot, soc_Wh: achievableWh });
  };

  for (const d of departures) addTarget(d.boundary, d.soc_percent); // departure with optional SoC
  for (const tg of mapped.filter(e => e.type === 'target')) addTarget(tg.boundary, tg.soc_percent);

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
    availabilityWindows: windows,
    targets: dedupedTargets,
  };
}
