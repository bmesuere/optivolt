export function buildLP({
  // time series data of length T
  load_W, // expected house load in W
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
  charge_efficiency_percent = 90,
  discharge_efficiency_percent = 90,

  // variable parameters
  initialSoc_percent = 20,
} = {}) {
  if (!Array.isArray(load_W) || !Array.isArray(importPrice) || !Array.isArray(exportPrice)) {
    throw new Error("Array params must be arrays.");
  }

  const T = load_W.length;
  if (importPrice.length !== T || exportPrice.length !== T) {
    throw new Error("Arrays must have same length");
  }

  // Unit helpers
  const stepHours = stepSize_m / 60; // hours per slot
  const priceCoeff = stepHours / 1000; // converts c€/kWh * W  →  c€ over the slot: € * (W * h / 1000 kWh/W) = €
  const chargeWhPerW = stepHours * (charge_efficiency_percent / 100); // Wh gained in battery per W charged
  const dischargeWhPerW = stepHours / (discharge_efficiency_percent / 100); // Wh lost from battery per W discharged

  // Convert soc percentages to Wh
  const minSoc_Wh = (minSoc_percent / 100) * batteryCapacity_Wh;
  const maxSoc_Wh = (maxSoc_percent / 100) * batteryCapacity_Wh;
  const initialSoc_Wh = (initialSoc_percent / 100) * batteryCapacity_Wh;

  // Variable name helpers
  const gridImport = (t) => `grid_import_${t}`;
  const gridExport = (t) => `grid_export_${t}`;
  const batCharge = (t) => `bat_charge_${t}`;
  const batDischarge = (t) => `bat_discharge_${t}`;
  const socEnd = (t) => `soc_${t}`;

  const lines = [];

  // ===============
  // Objective
  // ===============

  lines.push("Minimize");
  const objTerms = [" obj:"];
  for (let t = 0; t < T; t++) {
    // cost: + import - export
    objTerms.push(
      ` + ${toNum(importPrice[t] * priceCoeff)} ${gridImport(t)}`,
      ` - ${toNum(exportPrice[t] * priceCoeff)} ${gridExport(t)}`
    );
  }
  lines.push(objTerms.join(""));
  lines.push("");

  // ===============
  // Constraints
  // ===============
  lines.push("Subject To");

  // Power balance per slot
  // grid_import - grid_export + bat_discharge - bat_charge = load
  for (let t = 0; t < T; t++) {
    lines.push(` c_power_balance_${t}: ${gridImport(t)} - ${gridExport(t)} + ${batDischarge(t)} - ${batCharge(t)} = ${load_W[t]}`
    );
  }

  // SOC evolution
  // soc_0 = initialSoc_Wh + (ηc * Δh) * charge_0 - (Δh / ηd) * discharge_0
  lines.push(` soc_0: ${socEnd(0)} - ${chargeWhPerW} ${batCharge(0)} + ${dischargeWhPerW} ${batDischarge(0)} = ${toNum(initialSoc_Wh)}`);
  for (let t = 1; t < T; t++) {
    // soc_t - soc_{t-1} - (ηc * Δh) * charge_t + (Δh / ηd) * discharge_t = 0
    lines.push(` soc_${t}: ${socEnd(t)} - ${socEnd(t - 1)} - ${chargeWhPerW} ${batCharge(t)} + ${dischargeWhPerW} ${batDischarge(t)} = 0`);
  }

  // Limits per slot
  for (let t = 0; t < T; t++) {
    lines.push(` import_cap_${t}: ${gridImport(t)} <= ${maxGridImport_W}`);
    lines.push(` export_cap_${t}: ${gridExport(t)} <= ${maxGridExport_W}`);
    lines.push(` charge_cap_${t}: ${batCharge(t)} <= ${maxChargePower_W}`);
    lines.push(` discharge_cap_${t}: ${batDischarge(t)} <= ${maxDischargePower_W}`);
  }
  lines.push("");

  // ===============
  // Bounds
  // ===============
  lines.push("Bounds");
  for (let t = 0; t < T; t++) {
    lines.push(` 0 <= ${gridImport(t)} <= ${maxGridImport_W}`);
    lines.push(` 0 <= ${gridExport(t)} <= ${maxGridExport_W}`);
    lines.push(` 0 <= ${batCharge(t)} <= ${maxChargePower_W}`);
    lines.push(` 0 <= ${batDischarge(t)} <= ${maxDischargePower_W}`);
    lines.push(` ${minSoc_Wh} <= ${socEnd(t)} <= ${maxSoc_Wh}`);
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
