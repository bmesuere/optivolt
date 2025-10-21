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
  charge_efficiency_percent = 95,
  discharge_efficiency_percent = 95,
  batteryCostCent_per_kWh = 2,

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

  // Unit helpers
  const stepHours = stepSize_m / 60; // hours per slot
  const priceCoeff = stepHours / 1000; // converts c€/kWh * W  →  c€ over the slot: € * (W * h / 1000 kWh/W) = €
  const chargeWhPerW = stepHours * (charge_efficiency_percent / 100); // Wh gained in battery per W charged
  const dischargeWhPerW = stepHours / (discharge_efficiency_percent / 100); // Wh lost from battery per W discharged
  const batteryCost_cents = 0.5 * batteryCostCent_per_kWh * priceCoeff; // c€ cost per W throughput (charge+discharge)

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
    const pvToGridCoeff = -exportCoeff_cents + 1e-6; // export revenue + slight penalty to prefer using PV locally
    const batteryToGridCoeff = -exportCoeff_cents + batteryCost_cents; // export revenue + battery cost
    const batteryToLoadCoeff = batteryCost_cents; // battery cost
    const pvToBatteryCoeff = batteryCost_cents; // battery cost

    // Add each variable to the objective once with its final coefficient
    if (gridToLoadCoeff !== 0) objTerms.push(` + ${toNum(gridToLoadCoeff)} ${gridToLoad(t)}`);
    if (gridToBatteryCoeff !== 0) objTerms.push(` + ${toNum(gridToBatteryCoeff)} ${gridToBattery(t)}`);
    if (pvToGridCoeff !== 0) objTerms.push(` ${toNum(pvToGridCoeff)} ${pvToGrid(t)}`);
    if (batteryToGridCoeff !== 0) objTerms.push(` ${toNum(batteryToGridCoeff)} ${batteryToGrid(t)}`);
    if (batteryToLoadCoeff !== 0) objTerms.push(` + ${toNum(batteryToLoadCoeff)} ${batteryToLoad(t)}`);
    if (pvToBatteryCoeff !== 0) objTerms.push(` + ${toNum(pvToBatteryCoeff)} ${pvToBattery(t)}`);
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
    lines.push(` ${toNum(minSoc_Wh)} <= ${soc(t)} <= ${toNum(maxSoc_Wh)}`);
  }
  lines.push("");

  lines.push("End");

  return lines.join("\n");
}

// Pretty numeric printing; avoids scientific notation and ensures pure numbers.
function toNum(x) {
  // keep reasonable precision for LP parser; strip trailing zeros
  const s = (Math.round((+x + Number.EPSILON) * 1e12) / 1e12).toString();
  return s.includes("e") ? (+x).toFixed(12) : s;
}
