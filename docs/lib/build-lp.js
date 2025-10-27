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
  terminalSocValuation = "zero", // zero, min, avg or max

  // variable parameters
  initialSoc_percent = 20,
} = {}) {
  if (!Array.isArray(load_W) || !Array.isArray(pv_W) || !Array.isArray(importPrice) || !Array.isArray(exportPrice)) {
    throw new Error("Array params must be arrays.");
  }

  const T = load_W.length;
  if (pv_W.length !== T || importPrice.length !== T || exportPrice.length !== T) {
    throw new Error("Arrays must have same length");
  }

  const TIEBREAK = {
    avoidExport: 2e-6, // stronger nudge: prefer pv used locally over pv→grid
    pvToLoad: 1e-6,    // weaker nudge: prefer pv→load over pv→battery
  }
  const softMinSocPenalty_cents_per_Wh = 0.05; // penalty to keep soc above minSoc when possible

  // Unit helpers
  const stepHours = stepSize_m / 60; // hours per slot
  const priceCoeff = stepHours / 1000; // converts c€/kWh * W  →  c€ over the slot: € * (W * h / 1000 kWh/W) = €
  const chargeWhPerW = stepHours * (chargeEfficiency_percent / 100); // Wh gained in battery per W charged
  const dischargeWhPerW = stepHours / (dischargeEfficiency_percent / 100); // Wh lost from battery per W discharged
  const batteryCost_cents = 0.5 * batteryCost_cent_per_kWh * priceCoeff; // c€ cost per W throughput (charge+discharge)

  const terminalPrice_cents_per_Wh = selectTerminalPriceCentsPerKWh(terminalSocValuation, importPrice) / 1000 * (dischargeEfficiency_percent / 100); // c€/Wh

  // Convert soc percentages to Wh
  const minSoc_Wh = (minSoc_percent / 100) * batteryCapacity_Wh;
  const maxSoc_Wh = (maxSoc_percent / 100) * batteryCapacity_Wh;
  const initialSoc_Wh = (initialSoc_percent / 100) * batteryCapacity_Wh;

  // Variable name helpers
  const gridToLoad = (t) => `grid_to_load_${t}`;
  const gridToBattery = (t) => `grid_to_battery_${t}`;
  const pvToLoad = (t) => `pv_to_load_${t}`;
  const pvToBattery = (t) => `pv_to_battery_${t}`;
  const pvToGrid = (t) => `pv_to_grid_${t}`;
  const batteryToLoad = (t) => `battery_to_load_${t}`;
  const batteryToGrid = (t) => `battery_to_grid_${t}`;
  const soc = (t) => `soc_${t}`;
  const socShortfall = (t) => `soc_shortfall_${t}`;

  const lines = [];

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
    lines.push(` c_pv_split_${t}: ${pvToLoad(t)} + ${pvToBattery(t)} + ${pvToGrid(t)} = ${pv_W[t]}`
    );
  }

  // SOC evolution
  // soc_0 = initialSoc_Wh + (ηc * Δh) * (grid_to_battery_0 + pv_to_battery_0) - (Δh / ηd) * (battery_to_load_0 + battery_to_grid_0)
  lines.push(` c_soc_0: ${soc(0)} - ${toNum(chargeWhPerW)} ${gridToBattery(0)} - ${toNum(chargeWhPerW)} ${pvToBattery(0)} + ${toNum(dischargeWhPerW)} ${batteryToLoad(0)} + ${toNum(dischargeWhPerW)} ${batteryToGrid(0)} = ${toNum(initialSoc_Wh)}`);
  for (let t = 1; t < T; t++) {
    lines.push(` c_soc_${t}: ${soc(t)} - ${soc(t - 1)} - ${toNum(chargeWhPerW)} ${gridToBattery(t)} - ${toNum(chargeWhPerW)} ${pvToBattery(t)} + ${toNum(dischargeWhPerW)} ${batteryToLoad(t)} + ${toNum(dischargeWhPerW)} ${batteryToGrid(t)} = 0`);
  }

  // Limits per slot
  for (let t = 0; t < T; t++) {
    // Charge/discharge limits
    lines.push(` c_charge_cap_${t}: ${gridToBattery(t)} + ${pvToBattery(t)} <= ${maxChargePower_W}`);
    lines.push(` c_discharge_cap_${t}: ${batteryToLoad(t)} + ${batteryToGrid(t)} <= ${maxDischargePower_W}`);

    // Grid import/export limits
    lines.push(` c_grid_import_cap_${t}: ${gridToLoad(t)} + ${gridToBattery(t)} <= ${maxGridImport_W}`);
    lines.push(` c_grid_export_cap_${t}: ${pvToGrid(t)} + ${batteryToGrid(t)} <= ${maxGridExport_W}`);

    // Soft min SOC constraint
    lines.push(` c_min_soc_${t}: ${socShortfall(t)} + ${soc(t)} >= ${minSoc_Wh}`);
  }
  lines.push("");

  // ===============
  // Bounds
  // ===============
  lines.push("Bounds");
  for (let t = 0; t < T; t++) {
    // Grid → load/battery (cannot exceed import limit; load cap for the load branch)
    lines.push(` 0 <= ${gridToLoad(t)} <= ${toNum(Math.min(maxGridImport_W, +load_W[t]))}`);
    lines.push(` 0 <= ${gridToBattery(t)} <= ${toNum(Math.min(maxGridImport_W, maxChargePower_W))}`);

    // PV splits (no curtailment overall; per-branch caps keep things sane)
    lines.push(` 0 <= ${pvToLoad(t)} <= ${toNum(+load_W[t])}`);
    lines.push(` 0 <= ${pvToBattery(t)} <= ${toNum(Math.min(+pv_W[t], maxChargePower_W))}`);
    lines.push(` 0 <= ${pvToGrid(t)} <= ${toNum(Math.min(+pv_W[t], maxGridExport_W))}`);

    // Battery → load/grid (cannot exceed discharge or respective sinks)
    lines.push(` 0 <= ${batteryToLoad(t)} <= ${toNum(Math.min(maxDischargePower_W, +load_W[t]))}`);
    lines.push(` 0 <= ${batteryToGrid(t)} <= ${toNum(Math.min(maxDischargePower_W, maxGridExport_W))}`);

    // SOC bounds
    // minSoc handled via soft constraint
    lines.push(` ${soc(t)} <= ${toNum(maxSoc_Wh)}`);
    lines.push(` ${socShortfall(t)} >= 0`);
  }
  lines.push("");

  lines.push("End");

  return lines.join("\n");
}

function selectTerminalPriceCentsPerKWh(mode, prices) {
  if (mode === "min") return Math.min(...prices);
  if (mode === "avg") return prices.reduce((a, b) => a + b, 0) / prices.length;
  if (mode === "max") return Math.max(...prices);
  return 0; // "zero"
}

// Pretty numeric printing; avoids scientific notation and ensures pure numbers.
function toNum(x) {
  // keep reasonable precision for LP parser; strip trailing zeros
  const s = (Math.round((+x + Number.EPSILON) * 1e12) / 1e12).toString();
  return s.includes("e") ? (+x).toFixed(12) : s;
}
