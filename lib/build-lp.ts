import type { SolverConfig, TerminalSocValuation } from './types.ts';

export function buildLP({
  // time series data of length T
  load_W, // expected house load in W
  pv_W, // expected PV production in W
  importPrice, // import price in c€/kWh
  exportPrice, // export price in c€/kWh

  // static parameters
  stepSize_m = 15,
  batteryCapacity_Wh = 204800,
  minSoc_percent = 20,
  maxSoc_percent = 100,
  maxChargePower_W = 3600,
  maxDischargePower_W = 4000,
  maxGridImport_W = 2500,
  maxGridExport_W = 5000,
  chargeEfficiency_percent = 95,
  dischargeEfficiency_percent = 95,
  batteryCost_cent_per_kWh = 2,
  idleDrain_W = 40,

  // terminal SOC valuation:
  // - "zero": no valuation
  // - "min" | "avg" | "max": derived from importPrice array
  // - "custom": use terminalSocCustomPrice_cents_per_kWh
  terminalSocValuation = "zero",
  terminalSocCustomPrice_cents_per_kWh = 0,

  // variable parameters
  initialSoc_percent = 20,

  // rebalancing (MILP)
  rebalanceRemainingSlots,
  rebalanceTargetSoc_percent,
  ev,
}: SolverConfig): string {
  const T = load_W.length;
  if (pv_W.length !== T || importPrice.length !== T || exportPrice.length !== T) {
    throw new Error("Arrays must have same length");
  }

  const TIEBREAK = {
    avoidExport: 2e-6,   // stronger nudge: prefer pv used locally over pv→grid
    pvToLoad: 1e-6,      // weaker nudge: prefer pv→load over pv→battery
    preferPvForEv: 1e-6, // prefer pv→ev over grid→ev
  }
  const softMinSocPenalty_cents_per_Wh = 0.05; // penalty to keep soc above minSoc when possible

  // Unit helpers
  const stepHours = stepSize_m / 60; // hours per slot
  const priceCoeff = stepHours / 1000; // converts c€/kWh * W  →  c€ over the slot: € * (W * h / 1000 kWh/W) = €
  const chargeWhPerW = stepHours * (chargeEfficiency_percent / 100); // Wh gained in battery per W charged
  const dischargeWhPerW = stepHours / (dischargeEfficiency_percent / 100); // Wh lost from battery per W discharged
  const batteryCost_cents = 0.5 * batteryCost_cent_per_kWh * priceCoeff; // c€ cost per W throughput (charge+discharge)
  const idleDrain_Wh = idleDrain_W * stepHours; // Wh lost from battery per slot due to inverter idle consumption

  const terminalPrice_cents_per_Wh = selectTerminalPriceCentsPerKWh(terminalSocValuation, importPrice, terminalSocCustomPrice_cents_per_kWh) / 1000 * (dischargeEfficiency_percent / 100); // c€/Wh

  // Convert soc percentages to Wh
  const minSoc_Wh = (minSoc_percent / 100) * batteryCapacity_Wh;
  const maxSoc_Wh = (maxSoc_percent / 100) * batteryCapacity_Wh;
  const initialSoc_Wh = (initialSoc_percent / 100) * batteryCapacity_Wh;

  // Rebalancing MILP: number of slots remaining in the hold window.
  // Truncate to integer to guard against fractional values from future callers.
  // Clamp to [0, T] — D > T is unsatisfiable; D <= 0 means no rebalancing this solve.
  const D = Math.min(T, Math.max(0, Math.trunc(rebalanceRemainingSlots ?? 0)));
  // Clamp target SoC to maxSoc_percent so the model is never forced above its own upper bound.
  const safeTargetSoc_percent = Math.min(rebalanceTargetSoc_percent ?? maxSoc_percent, maxSoc_percent);
  const rebalanceTargetSoc_Wh = D > 0
    ? (safeTargetSoc_percent / 100) * batteryCapacity_Wh
    : 0;
  const startBalance = (k: number) => `start_balance_${k}`;

  // EV variable name helpers
  const gridToEv    = (t: number) => `grid_to_ev_${t}`;
  const pvToEv      = (t: number) => `pv_to_ev_${t}`;
  const batteryToEv = (t: number) => `battery_to_ev_${t}`;
  const evOn        = (t: number) => `ev_on_${t}`;
  const evSocVar    = (t: number) => `ev_soc_${t}`;

  // EV derived constants (only used when ev is defined)
  const evActive     = ev != null;
  const evCapacityWh = ev?.evBatteryCapacity_Wh ?? 0;
  const evInitialWh  = (ev?.evInitialSoc_percent ?? 0) / 100 * evCapacityWh;
  const evTargetWh   = (ev?.evTargetSoc_percent  ?? 0) / 100 * evCapacityWh;
  const evMinPow_W   = ev?.evMinChargePower_W ?? 0;
  const evMaxPow_W   = ev?.evMaxChargePower_W ?? 0;
  const evDepSlot    = ev?.evDepartureSlot ?? (T + 1);

  // Variable name helpers
  const gridToLoad = (t: number) => `grid_to_load_${t}`;
  const gridToBattery = (t: number) => `grid_to_battery_${t}`;
  const pvToLoad = (t: number) => `pv_to_load_${t}`;
  const pvToBattery = (t: number) => `pv_to_battery_${t}`;
  const pvToGrid = (t: number) => `pv_to_grid_${t}`;
  const batteryToLoad = (t: number) => `battery_to_load_${t}`;
  const batteryToGrid = (t: number) => `battery_to_grid_${t}`;
  const soc = (t: number) => `soc_${t}`;
  const socShortfall = (t: number) => `soc_shortfall_${t}`;

  const lines: string[] = [];

  // ===============
  // Objective
  // ===============
  lines.push("Minimize");
  const objTerms = [" obj:"];
  for (let t = 0; t < T; t++) {
    const importCoeff_cents = importPrice[t] * priceCoeff; // c€
    const exportCoeff_cents = exportPrice[t] * priceCoeff; // c€

    // Aggregate coefficients for each variable
    const gridToLoadCoeff = importCoeff_cents; // import cost
    const gridToBatteryCoeff = importCoeff_cents + batteryCost_cents; // import cost + battery cost
    const pvToGridCoeff = -exportCoeff_cents + TIEBREAK.avoidExport; // export revenue + slight penalty to prefer using PV locally
    const batteryToGridCoeff = -exportCoeff_cents + batteryCost_cents; // export revenue + battery cost
    const batteryToLoadCoeff = batteryCost_cents; // battery cost
    const pvToBatteryCoeff = batteryCost_cents + TIEBREAK.pvToLoad; // battery cost
    const socShortfallCoeff = softMinSocPenalty_cents_per_Wh; // penalty for being below minSoc

    // Add each variable to the objective once with its final coefficient
    if (gridToLoadCoeff !== 0) objTerms.push(` + ${toNum(gridToLoadCoeff)} ${gridToLoad(t)}`);
    if (gridToBatteryCoeff !== 0) objTerms.push(` + ${toNum(gridToBatteryCoeff)} ${gridToBattery(t)}`);
    if (pvToGridCoeff !== 0) objTerms.push(` + ${toNum(pvToGridCoeff)} ${pvToGrid(t)}`);
    if (batteryToGridCoeff !== 0) objTerms.push(` + ${toNum(batteryToGridCoeff)} ${batteryToGrid(t)}`);
    if (batteryToLoadCoeff !== 0) objTerms.push(` + ${toNum(batteryToLoadCoeff)} ${batteryToLoad(t)}`);
    if (pvToBatteryCoeff !== 0) objTerms.push(` + ${toNum(pvToBatteryCoeff)} ${pvToBattery(t)}`);
    if (evActive) {
      const gridToEvCoeff = importCoeff_cents + TIEBREAK.preferPvForEv;
      objTerms.push(` + ${toNum(gridToEvCoeff)} ${gridToEv(t)}`);
      objTerms.push(` + ${toNum(TIEBREAK.pvToLoad)} ${pvToEv(t)}`);
      if (batteryCost_cents !== 0) objTerms.push(` + ${toNum(batteryCost_cents)} ${batteryToEv(t)}`);
    }
    objTerms.push(` + ${toNum(socShortfallCoeff)} ${socShortfall(t)}`);
  }
  // Terminal SOC valuation
  if (terminalPrice_cents_per_Wh > 0) {
    objTerms.push(` - ${toNum(terminalPrice_cents_per_Wh)} ${soc(T - 1)}`);
  }
  lines.push(objTerms.join(""));
  lines.push("");

  // ===============
  // Constraints
  // ===============
  lines.push("Subject To");

  // Load must be met
  for (let t = 0; t < T; t++) {
    lines.push(` c_load_${t}: ${gridToLoad(t)} + ${pvToLoad(t)} + ${batteryToLoad(t)} = ${load_W[t]}`
    );
  }

  // PV split
  for (let t = 0; t < T; t++) {
    const pvEvTerm = evActive ? ` + ${pvToEv(t)}` : '';
    lines.push(` c_pv_split_${t}: ${pvToLoad(t)} + ${pvToBattery(t)} + ${pvToGrid(t)}${pvEvTerm} = ${pv_W[t]}`);
  }

  // SOC evolution (includes idle drain: inverter consumes idleDrain_Wh per slot)
  // soc_0 = initialSoc_Wh - idleDrain_Wh + (ηc * Δh) * (grid_to_battery_0 + pv_to_battery_0) - (Δh / ηd) * (battery_to_load_0 + battery_to_grid_0 + battery_to_ev_0)
  const evBatTerm = (t: number) => evActive ? ` + ${toNum(dischargeWhPerW)} ${batteryToEv(t)}` : '';
  lines.push(` c_soc_0: ${soc(0)} - ${toNum(chargeWhPerW)} ${gridToBattery(0)} - ${toNum(chargeWhPerW)} ${pvToBattery(0)} + ${toNum(dischargeWhPerW)} ${batteryToLoad(0)} + ${toNum(dischargeWhPerW)} ${batteryToGrid(0)}${evBatTerm(0)} = ${toNum(initialSoc_Wh - idleDrain_Wh)}`);
  for (let t = 1; t < T; t++) {
    lines.push(` c_soc_${t}: ${soc(t)} - ${soc(t - 1)} - ${toNum(chargeWhPerW)} ${gridToBattery(t)} - ${toNum(chargeWhPerW)} ${pvToBattery(t)} + ${toNum(dischargeWhPerW)} ${batteryToLoad(t)} + ${toNum(dischargeWhPerW)} ${batteryToGrid(t)}${evBatTerm(t)} = ${toNum(-idleDrain_Wh)}`);
  }

  // Limits per slot
  for (let t = 0; t < T; t++) {
    // Charge/discharge limits
    lines.push(` c_charge_cap_${t}: ${gridToBattery(t)} + ${pvToBattery(t)} <= ${maxChargePower_W}`);
    const batEvTerm = evActive ? ` + ${batteryToEv(t)}` : '';
    lines.push(` c_discharge_cap_${t}: ${batteryToLoad(t)} + ${batteryToGrid(t)}${batEvTerm} <= ${maxDischargePower_W}`);

    // Grid import/export limits
    const gridEvTerm = evActive ? ` + ${gridToEv(t)}` : '';
    lines.push(` c_grid_import_cap_${t}: ${gridToLoad(t)} + ${gridToBattery(t)}${gridEvTerm} <= ${maxGridImport_W}`);
    lines.push(` c_grid_export_cap_${t}: ${pvToGrid(t)} + ${batteryToGrid(t)} <= ${maxGridExport_W}`);

    // Soft min SOC constraint
    lines.push(` c_min_soc_${t}: ${socShortfall(t)} + ${soc(t)} >= ${minSoc_Wh}`);
  }

  // MILP rebalancing: force a contiguous window of D slots to hold the battery at target SoC
  if (D > 0) {
    // Exactly-one-start constraint: exactly one window starting position is chosen
    const startVars: string[] = [];
    for (let k = 0; k <= T - D; k++) {
      startVars.push(startBalance(k));
    }
    lines.push(` c_balance_start: ${startVars.join(' + ')} = 1`);

    // Per-slot SoC forcing: soc_t >= rebalanceTargetSoc_Wh when slot t is in the chosen window
    for (let t = 0; t < T; t++) {
      const kLow = Math.max(0, t - D + 1);
      const kHigh = Math.min(t, T - D);
      if (kLow > kHigh) continue; // no valid start position covers this slot
      const terms: string[] = [];
      for (let k = kLow; k <= kHigh; k++) {
        terms.push(` - ${toNum(rebalanceTargetSoc_Wh)} ${startBalance(k)}`);
      }
      lines.push(` c_rebalance_${t}: ${soc(t)}${terms.join('')} >= 0`);
    }
  }

  // EV charging constraints (MILP)
  if (evActive) {
    for (let t = 0; t < T; t++) {
      lines.push(` c_ev_min_${t}: ${gridToEv(t)} + ${pvToEv(t)} + ${batteryToEv(t)} - ${toNum(evMinPow_W)} ${evOn(t)} >= 0`);
      lines.push(` c_ev_max_${t}: ${gridToEv(t)} + ${pvToEv(t)} + ${batteryToEv(t)} - ${toNum(evMaxPow_W)} ${evOn(t)} <= 0`);
    }

    lines.push(` c_ev_soc_0: ${evSocVar(0)} - ${toNum(stepHours)} ${gridToEv(0)} - ${toNum(stepHours)} ${pvToEv(0)} - ${toNum(stepHours)} ${batteryToEv(0)} = ${toNum(evInitialWh)}`);
    for (let t = 1; t < T; t++) {
      lines.push(` c_ev_soc_${t}: ${evSocVar(t)} - ${evSocVar(t - 1)} - ${toNum(stepHours)} ${gridToEv(t)} - ${toNum(stepHours)} ${pvToEv(t)} - ${toNum(stepHours)} ${batteryToEv(t)} = 0`);
    }

    if (evDepSlot <= T && evDepSlot > 0) {
      lines.push(` c_ev_target: ${evSocVar(evDepSlot - 1)} >= ${toNum(evTargetWh)}`);
    }
  }

  lines.push("");

  // ===============
  // Bounds
  // ===============
  lines.push("Bounds");
  for (let t = 0; t < T; t++) {
    // Grid → load/battery (cannot exceed import limit; load cap for the load branch)
    lines.push(` 0 <= ${gridToLoad(t)} <= ${toNum(Math.min(maxGridImport_W, load_W[t]))}`);
    lines.push(` 0 <= ${gridToBattery(t)} <= ${toNum(Math.min(maxGridImport_W, maxChargePower_W))}`);

    // PV splits (no curtailment overall; per-branch caps keep things sane)
    lines.push(` 0 <= ${pvToLoad(t)} <= ${toNum(load_W[t])}`);
    lines.push(` 0 <= ${pvToBattery(t)} <= ${toNum(Math.min(pv_W[t], maxChargePower_W))}`);
    lines.push(` 0 <= ${pvToGrid(t)} <= ${toNum(Math.min(pv_W[t], maxGridExport_W))}`);

    // Battery → load/grid (cannot exceed discharge or respective sinks)
    lines.push(` 0 <= ${batteryToLoad(t)} <= ${toNum(Math.min(maxDischargePower_W, load_W[t]))}`);
    lines.push(` 0 <= ${batteryToGrid(t)} <= ${toNum(Math.min(maxDischargePower_W, maxGridExport_W))}`);

    // SOC bounds
    // minSoc handled via soft constraint
    lines.push(` ${soc(t)} <= ${toNum(maxSoc_Wh)}`);
    lines.push(` ${socShortfall(t)} >= 0`);
    if (evActive) {
      lines.push(` 0 <= ${gridToEv(t)} <= ${toNum(evMaxPow_W)}`);
      lines.push(` 0 <= ${pvToEv(t)} <= ${toNum(Math.min(pv_W[t], evMaxPow_W))}`);
      lines.push(` 0 <= ${batteryToEv(t)} <= ${toNum(Math.min(maxDischargePower_W, evMaxPow_W))}`);
      lines.push(` 0 <= ${evSocVar(t)} <= ${toNum(evCapacityWh)}`);
    }
  }
  lines.push("");

  if (D > 0 || evActive) {
    lines.push("Binaries");
    if (D > 0) {
      for (let k = 0; k <= T - D; k++) {
        lines.push(` start_balance_${k}`);
      }
    }
    if (evActive) {
      for (let t = 0; t < T; t++) {
        lines.push(` ${evOn(t)}`);
      }
    }
    lines.push("");
  }

  lines.push("End");

  return lines.join("\n");
}

function selectTerminalPriceCentsPerKWh(mode: TerminalSocValuation, prices: number[], customPrice_cents_per_kWh = 0): number {
  if (mode === "min") return Math.min(...prices);
  if (mode === "avg") return prices.reduce((a, b) => a + b, 0) / prices.length;
  if (mode === "max") return Math.max(...prices);
  if (mode === "custom") return customPrice_cents_per_kWh;
  return 0; // "zero"
}

// Pretty numeric printing; avoids scientific notation and ensures pure numbers.
function toNum(x: number): string {
  // keep reasonable precision for LP parser; strip trailing zeros
  const s = (Math.round((+x + Number.EPSILON) * 1e12) / 1e12).toString();
  return s.includes("e") ? (+x).toFixed(12) : s;
}
