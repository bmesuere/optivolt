import type { EvConfig, PlanRow, SolverConfig } from './types.ts';

type HouseRow = Pick<PlanRow, 'ic' | 'soc_Wh' | 'imp' | 'pv2g' | 'b2l' | 'b2g'>;
type Cfg = Pick<SolverConfig,
  'stepSize_m' | 'batteryCapacity_Wh' | 'initialSoc_percent' | 'minSoc_percent' |
  'maxDischargePower_W' | 'maxGridImport_W' | 'dischargeEfficiency_percent'>;

export interface CheapestSourceFlows {
  g2ev: number[];
  pv2ev: number[];
  b2ev: number[];
}

/** Maximal runs of slots [start, end) in which the EV may charge (availability ∩ weekly mask). */
export function chargeStretches(ev: Pick<EvConfig, 'availabilityWindows' | 'chargeAllowed'>, T: number): [number, number][] {
  const mayCharge: boolean[] = Array(T).fill(false);
  for (const w of ev.availabilityWindows) {
    for (let t = Math.max(0, w.startSlot); t < Math.min(T, w.endSlot); t++) mayCharge[t] = true;
  }
  if (ev.chargeAllowed) for (let t = 0; t < T; t++) if (ev.chargeAllowed[t] === false) mayCharge[t] = false;
  const stretches: [number, number][] = [];
  for (let t = 0; t < T; t++) {
    if (!mayCharge[t]) continue;
    const last = stretches[stretches.length - 1];
    if (last && last[1] === t) last[1] = t + 1;
    else stretches.push([t, t + 1]);
  }
  return stretches;
}

/**
 * Cheapest-source EV charging (see EvConfig.cheapestSource): derive the EV flows for one stretch
 * of chargeable slots from a plan that does not charge the EV there yet (`houseRows`), slot by
 * slot in time order. `flows` holds what earlier stretches already decided; `houseRows` must be
 * solved with those, so that the battery it shows is what is really left for this stretch.
 *
 * In every slot the EV may charge and is still below its ceiling (the window's target SoC):
 *  1. PV the house would otherwise export goes to the EV;
 *  2. when the import price is below `essFloorGridPriceLimit_cents_per_kWh` the rest comes from
 *     the grid;
 *  3. otherwise it comes from the home battery: first what the EV-less plan would sell to the grid
 *     in that slot, then more — with whatever discharge power the house leaves free, and only
 *     while the battery stays at or above the floor (the minimum SoC when no floor is set) at
 *     both ends of the slot.
 * A slot that cannot reach the charger's minimum power does not charge. There is no deadline: a
 * ceiling that is not reached is simply not reached.
 *
 * The house is never pushed onto the grid to make room for the EV within a slot; what the EV
 * takes from the battery is missing later, which the follow-up solve (EV flows fixed) covers.
 */
export function planCheapestSourceEv(
  houseRows: HouseRow[],
  cfg: Cfg,
  ev: EvConfig,
  prior: CheapestSourceFlows,
  [stretchStart, stretchEnd]: [number, number],
): CheapestSourceFlows {
  const T = houseRows.length;
  const stepHours = cfg.stepSize_m / 60;
  const evChargeWhPerW = stepHours * (ev.evChargeEfficiency_percent / 100);
  const dischargeWhPerW = stepHours / (cfg.dischargeEfficiency_percent / 100);
  const evCapacity_Wh = ev.evBatteryCapacity_Wh;
  const floor_Wh = Math.max(ev.essSocFloor_Wh ?? 0, (cfg.minSoc_percent / 100) * cfg.batteryCapacity_Wh);
  const priceLimit = ev.essFloorGridPriceLimit_cents_per_kWh;
  const initialSoc_Wh = (cfg.initialSoc_percent / 100) * cfg.batteryCapacity_Wh;

  const resetAt = new Map<number, number>();
  for (const w of ev.availabilityWindows) {
    if (w.resetSoc_Wh != null && w.startSlot > 0) resetAt.set(w.startSlot, w.resetSoc_Wh);
  }

  // Ceiling per slot: the next target at or after it.
  const targets = [...ev.targets].sort((a, b) => a.slot - b.slot);
  const ceilingAt = (t: number) => targets.find((tg) => tg.slot >= t)?.soc_Wh ?? 0;

  const flows: CheapestSourceFlows = { g2ev: [...prior.g2ev], pv2ev: [...prior.pv2ev], b2ev: [...prior.b2ev] };
  let evSoc_Wh = (ev.evInitialSoc_percent / 100) * evCapacity_Wh;
  let drained_Wh = 0; // battery energy taken by the EV in this stretch, on top of `houseRows`

  for (let t = 0; t < Math.min(T, stretchEnd); t++) {
    const reset = resetAt.get(t);
    if (reset != null) evSoc_Wh = reset;
    if (t < stretchStart) {
      // Replay what earlier stretches charged to know the EV SoC this one starts from.
      evSoc_Wh += (flows.g2ev[t] + flows.pv2ev[t] + flows.b2ev[t]) * evChargeWhPerW;
      continue;
    }
    const room_Wh = Math.min(ceilingAt(t), evCapacity_Wh) - evSoc_Wh;
    if (room_Wh <= 0) continue;
    const row = houseRows[t];
    const max_W = Math.min(ev.evMaxChargePower_W, room_Wh / evChargeWhPerW);

    const pv = Math.max(0, Math.min(row.pv2g, max_W));
    let grid = 0;
    let battery = 0;
    let extraDrain_W = 0; // battery power on top of what the EV-less plan already discharges
    if (priceLimit != null && row.ic < priceLimit) {
      grid = Math.max(0, Math.min(max_W - pv, cfg.maxGridImport_W - row.imp));
    } else {
      const startSoc_Wh = (t > 0 ? houseRows[t - 1].soc_Wh : initialSoc_Wh) - drained_Wh;
      const endSoc_Wh = row.soc_Wh - drained_Wh;
      if (startSoc_Wh >= floor_Wh && endSoc_Wh >= floor_Wh) {
        // Energy the EV-less plan exports from the battery is redirected at no cost to the SoC.
        const fromExport = Math.max(0, Math.min(max_W - pv, row.b2g));
        const freePower_W = cfg.maxDischargePower_W - row.b2l - row.b2g;
        const aboveFloor_W = (endSoc_Wh - floor_Wh) / dischargeWhPerW;
        extraDrain_W = Math.max(0, Math.min(max_W - pv - fromExport, freePower_W, aboveFloor_W));
        battery = fromExport + extraDrain_W;
      }
    }
    // Rounded down so the fixed flows never overshoot a limit by rounding.
    const total = Math.floor(pv) + Math.floor(grid) + Math.floor(battery);
    if (total < ev.evMinChargePower_W) continue;
    flows.pv2ev[t] = Math.floor(pv);
    flows.g2ev[t] = Math.floor(grid);
    flows.b2ev[t] = Math.floor(battery);
    drained_Wh += extraDrain_W * dischargeWhPerW;
    evSoc_Wh += total * evChargeWhPerW;
  }
  return flows;
}

/** Home battery SoC floors (end of slot t and of the slot before) for every slot the EV draws on it. */
export function batteryFloorsForFlows(b2ev: number[], floor_Wh: number): { slot: number; soc_Wh: number }[] {
  const slots = new Set<number>();
  b2ev.forEach((w, t) => {
    if (w <= 0) return;
    slots.add(t);
    if (t > 0) slots.add(t - 1);
  });
  return [...slots].sort((a, b) => a - b).map((slot) => ({ slot, soc_Wh: floor_Wh }));
}
