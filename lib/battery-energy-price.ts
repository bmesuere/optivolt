import type { PlanRow, SolverConfig } from './types.ts';

type PriceCfg = Pick<SolverConfig, 'stepSize_m' | 'chargeEfficiency_percent' | 'initialSoc_percent' | 'batteryCapacity_Wh'>;

/**
 * Track the average purchase price of the energy stored in the home battery through the plan,
 * in c€ per stored kWh, at the end of every slot.
 *
 * It is a running weighted average: energy leaving the battery (and idle drain) takes the current
 * average with it, energy coming in is blended in at what it cost — the import price for grid
 * charging (charge losses included, so 1 kWh bought stores less than 1 kWh) and zero for PV.
 *
 * `seed_cents_per_kWh` is the price of the energy already in the battery at the start of the
 * plan. When it is unknown (null) that energy carries no weight: the price stays null until the
 * first charge and is then based on charged energy only.
 */
export function trackBatteryEnergyPrice(
  rows: Pick<PlanRow, 'g2b' | 'pv2b' | 'ic' | 'soc_Wh'>[],
  cfg: PriceCfg,
  seed_cents_per_kWh: number | null,
): (number | null)[] {
  const stepHours = cfg.stepSize_m / 60;
  const chargeEfficiency = cfg.chargeEfficiency_percent / 100;
  let price = seed_cents_per_kWh != null && Number.isFinite(seed_cents_per_kWh) ? seed_cents_per_kWh : null;
  // Stored energy the current price applies to; unpriced initial energy is left out.
  let priced_Wh = price != null ? (cfg.initialSoc_percent / 100) * cfg.batteryCapacity_Wh : 0;
  let prevSoc_Wh = (cfg.initialSoc_percent / 100) * cfg.batteryCapacity_Wh;

  return rows.map((row) => {
    const charged_Wh = (row.g2b + row.pv2b) * stepHours * chargeEfficiency;
    const cost_cents = (row.g2b * stepHours / 1000) * row.ic;
    // What is left of the energy that was there at the start of the slot.
    const kept_Wh = Math.max(0, row.soc_Wh - charged_Wh);
    const keptShare = prevSoc_Wh > 0 ? Math.min(1, kept_Wh / prevSoc_Wh) : 0;
    const keptPriced_Wh = priced_Wh * keptShare;
    const total_Wh = keptPriced_Wh + charged_Wh;
    if (charged_Wh > 0 && total_Wh > 0) {
      price = ((price ?? 0) * (keptPriced_Wh / 1000) + cost_cents) / (total_Wh / 1000);
    }
    priced_Wh = total_Wh;
    prevSoc_Wh = row.soc_Wh;
    return price;
  });
}

/**
 * The battery energy price at `startMs`, taken from a previous plan: the tracked price at the end
 * of the slot just before `startMs`. A plan that starts in the same slot reuses that plan's seed.
 */
export function seedBatteryEnergyPrice(
  prev: { startMs: number; stepMin: number; seed_cents_per_kWh: number | null; prices: (number | null | undefined)[] } | undefined,
  startMs: number,
): number | null {
  if (!prev || !(prev.stepMin > 0)) return null;
  const elapsedSlots = Math.floor((startMs - prev.startMs) / (prev.stepMin * 60_000));
  if (elapsedSlots <= 0 || prev.prices.length === 0) return prev.seed_cents_per_kWh;
  return prev.prices[Math.min(elapsedSlots, prev.prices.length) - 1] ?? null;
}

/**
 * Starting estimate when no previous plan is available (first plan after a start): the mean of
 * the cheapest quarter of buy prices over the first day of the plan, since that is when a battery
 * gets charged. Without it the energy already in the battery would carry no weight and the first
 * bit of solar would read as a battery full of free energy. The estimate washes out as the
 * battery cycles.
 */
export function estimateBatteryEnergyPrice(rows: Pick<PlanRow, 'ic'>[], stepSize_m: number): number | null {
  const day = rows.slice(0, Math.max(1, Math.round((24 * 60) / stepSize_m)));
  const prices = day.map((r) => r.ic).filter((p) => Number.isFinite(p)).sort((a, b) => a - b);
  const cheap = prices.slice(0, Math.max(1, Math.ceil(prices.length / 4)));
  return cheap.length ? cheap.reduce((sum, p) => sum + p, 0) / cheap.length : null;
}
