import { SOLUTION_COLORS } from "./charts.js";

// ---------- UI <-> settings snapshot ----------
export function snapshotUI(els) {
  return {
    // scalars (SYSTEM)
    stepSize_m: num(els.step?.value),
    batteryCapacity_Wh: num(els.cap?.value),
    minSoc_percent: num(els.minsoc?.value),
    maxSoc_percent: num(els.maxsoc?.value),
    maxChargePower_W: num(els.pchg?.value),
    maxDischargePower_W: num(els.pdis?.value),
    maxGridImport_W: num(els.gimp?.value),
    maxGridExport_W: num(els.gexp?.value),
    chargeEfficiency_percent: num(els.etaC?.value),
    dischargeEfficiency_percent: num(els.etaD?.value),
    batteryCost_cent_per_kWh: num(els.bwear?.value),
    idleDrain_W: num(els.idleDrain?.value),

    // ALGORITHM
    terminalSocValuation: els.terminal?.value || "zero",
    terminalSocCustomPrice_cents_per_kWh: num(els.terminalCustom?.value),

    // DATA
    dataSources: {
      prices: els.sourcePrices?.value || "vrm",
      load: els.sourceLoad?.value || "vrm",
      pv: els.sourcePv?.value || "vrm",
      soc: els.sourceSoc?.value || "mqtt",
    },

    // ALGORITHM
    rebalanceEnabled: !!els.rebalanceEnabled?.checked,
    rebalanceHoldHours: num(els.rebalanceHoldHours?.value),

    // HOME ASSISTANT
    haUrl: els.haUrl?.value ?? '',
    haToken: els.haToken?.value ?? '',

    // EV CHARGING
    evEnabled: !!els.evEnabled?.checked,
    evMinChargeCurrent_A: num(els.evMinChargeCurrent?.value),
    evMaxChargeCurrent_A: num(els.evMaxChargeCurrent?.value),
    evBatteryCapacity_kWh: num(els.evBatteryCapacity?.value),
    evChargeEfficiency_percent: num(els.evChargeEfficiency?.value),
    evDepartureTime: els.evDepartureTime?.value ?? '',
    evTargetSoc_percent: num(els.evTargetSoc?.value),
    evSocSensor: els.evSocSensor?.value ?? '',
    evPlugSensor: els.evPlugSensor?.value ?? '',

    // UI-only
    tableShowKwh: !!els.tableKwh?.checked,
    // Note: updateDataBeforeRun / pushToVictron are not part of the persisted settings
  };
}

export function hydrateUI(els, obj = {}) {
  // SYSTEM
  setIfDef(els.step, obj.stepSize_m);
  setIfDef(els.cap, obj.batteryCapacity_Wh);
  setIfDef(els.minsoc, obj.minSoc_percent);
  setIfDef(els.maxsoc, obj.maxSoc_percent);
  setIfDef(els.pchg, obj.maxChargePower_W);
  setIfDef(els.pdis, obj.maxDischargePower_W);
  setIfDef(els.gimp, obj.maxGridImport_W);
  setIfDef(els.gexp, obj.maxGridExport_W);
  setIfDef(els.etaC, obj.chargeEfficiency_percent);
  setIfDef(els.etaD, obj.dischargeEfficiency_percent);
  setIfDef(els.bwear, obj.batteryCost_cent_per_kWh);
  setIfDef(els.idleDrain, obj.idleDrain_W);

  // DATA (display-only metadata)
  updatePlanMeta(els, obj.initialSoc_percent, obj.tsStart);

  // ALGORITHM
  if (els.terminal && obj.terminalSocValuation != null) {
    els.terminal.value = String(obj.terminalSocValuation);
  }
  setIfDef(els.terminalCustom, obj.terminalSocCustomPrice_cents_per_kWh);

  // DATA
  if (els.sourcePrices && obj.dataSources?.prices) els.sourcePrices.value = obj.dataSources.prices;
  if (els.sourceLoad && obj.dataSources?.load) els.sourceLoad.value = obj.dataSources.load;
  if (els.sourcePv && obj.dataSources?.pv) els.sourcePv.value = obj.dataSources.pv;
  if (els.sourceSoc && obj.dataSources?.soc) els.sourceSoc.value = obj.dataSources.soc;

  // Algorithm
  if (els.rebalanceEnabled && obj.rebalanceEnabled != null) {
    els.rebalanceEnabled.checked = !!obj.rebalanceEnabled;
  }
  setIfDef(els.rebalanceHoldHours, obj.rebalanceHoldHours);

  // HOME ASSISTANT
  setIfDef(els.haUrl, obj.haUrl);
  setIfDef(els.haToken, obj.haToken);
  if (els.haSettingsGroup) {
    els.haSettingsGroup.hidden = !!obj.isAddon;
  }

  // EV CHARGING
  if (els.evEnabled && obj.evEnabled != null) {
    els.evEnabled.checked = !!obj.evEnabled;
  }
  setIfDef(els.evMinChargeCurrent, obj.evMinChargeCurrent_A);
  setIfDef(els.evMaxChargeCurrent, obj.evMaxChargeCurrent_A);
  setIfDef(els.evBatteryCapacity, obj.evBatteryCapacity_kWh);
  setIfDef(els.evChargeEfficiency, obj.evChargeEfficiency_percent);
  setIfDef(els.evDepartureTime, obj.evDepartureTime);
  setIfDef(els.evTargetSoc, obj.evTargetSoc_percent);
  setIfDef(els.evSocSensor, obj.evSocSensor);
  setIfDef(els.evPlugSensor, obj.evPlugSensor);

  // UI-only
  if (els.tableKwh && obj.tableShowKwh != null) {
    els.tableKwh.checked = !!obj.tableShowKwh;
  }

  updateTerminalCustomUI(els);
}

// Plan metadata helper
export function updatePlanMeta(els, initialSoc_percent, tsStart) {
  if (els.planSocNow) {
    if (initialSoc_percent == null || !Number.isFinite(Number(initialSoc_percent))) {
      els.planSocNow.textContent = "—";
    } else {
      const n = Number(initialSoc_percent);
      els.planSocNow.textContent = String(Math.round(n));
    }
  }

  if (els.planTsStart) {
    if (!tsStart) {
      els.planTsStart.textContent = "—";
    } else {
      const raw = String(tsStart);
      let display = raw;
      const date = new Date(tsStart);
      if (!isNaN(date.getTime())) {
        const d = String(date.getDate()).padStart(2, "0");
        const m = String(date.getMonth() + 1).padStart(2, "0");
        const H = String(date.getHours()).padStart(2, "0");
        const M = String(date.getMinutes()).padStart(2, "0");
        display = `${d}/${m} ${H}:${M}`;
      }
      els.planTsStart.textContent = display;
    }
  }
}

// Summary helper
export function updateSummaryUI(els, summary) {
  if (!summary) {
    setText(els.sumLoad, "—");
    setText(els.sumPv, "—");
    setText(els.sumLoadGrid, "—");
    setText(els.sumLoadBatt, "—");
    setText(els.sumLoadPv, "—");
    setText(els.avgImport, "—");
    setText(els.gridBatteryTp, "—");
    setText(els.gridChargeTp, "—");
    setText(els.batteryExportTp, "—");
    updateRebalanceStatus(els, null);
    updateEvSummary(els, null);

    // reset mini bars
    const loadSplitBar = document.getElementById("load-split-bar");
    if (loadSplitBar) loadSplitBar.innerHTML = "";
    return;
  }

  const {
    loadTotal_kWh,
    pvTotal_kWh,
    loadFromGrid_kWh,
    loadFromBattery_kWh,
    loadFromPv_kWh,
    avgImportPrice_cents_per_kWh,
    gridBatteryTippingPoint_cents_per_kWh,
    gridChargeTippingPoint_cents_per_kWh,
    batteryExportTippingPoint_cents_per_kWh,
    pvExportTippingPoint_cents_per_kWh,
  } = summary;

  setText(els.sumLoad, formatKWh(loadTotal_kWh));
  setText(els.sumPv, formatKWh(pvTotal_kWh));
  setText(els.sumLoadGrid, formatKWh(loadFromGrid_kWh));
  setText(els.sumLoadBatt, formatKWh(loadFromBattery_kWh));
  setText(els.sumLoadPv, formatKWh(loadFromPv_kWh));
  setText(els.avgImport, formatCentsPerKWh(avgImportPrice_cents_per_kWh));
  setText(els.gridBatteryTp, formatTippingPoint(gridBatteryTippingPoint_cents_per_kWh, "↓"));
  setText(els.gridChargeTp, formatTippingPoint(gridChargeTippingPoint_cents_per_kWh, "↓"));
  // Show battery export tp if present, otherwise fall back to PV export tp
  const exportTp = batteryExportTippingPoint_cents_per_kWh ?? pvExportTippingPoint_cents_per_kWh;
  setText(els.batteryExportTp, formatTippingPoint(exportTp, "↑"));


  // --- Load Split Bar ---
  const loadTotal =
    (Number(loadFromGrid_kWh) || 0) +
    (Number(loadFromBattery_kWh) || 0) +
    (Number(loadFromPv_kWh) || 0);

  updateStackedBarContainer(
    document.getElementById("load-split-bar"),
    loadTotal,
    [
      { value: loadFromGrid_kWh, color: SOLUTION_COLORS.g2l, title: `Grid: ${formatKWh(loadFromGrid_kWh)}` },
      { value: loadFromBattery_kWh, color: SOLUTION_COLORS.b2l, title: `Battery: ${formatKWh(loadFromBattery_kWh)}` },
      { value: loadFromPv_kWh, color: SOLUTION_COLORS.pv2l, title: `PV: ${formatKWh(loadFromPv_kWh)}` },
    ]
  );

  updateRebalanceStatus(els, summary.rebalanceStatus);
  updateEvSummary(els, summary);

  // --- Energy Flow Bar ---
  const g2b = Number(summary.gridToBattery_kWh) || 0;
  const g2l = Number(loadFromGrid_kWh) || 0;
  const b2l = Number(loadFromBattery_kWh) || 0;
  const b2g = Number(summary.batteryToGrid_kWh) || 0;

  const flowTotal = g2b + g2l + b2l + b2g;

  updateStackedBarContainer(
    document.getElementById("flow-split-bar"),
    flowTotal,
    [
      { value: g2b, color: SOLUTION_COLORS.g2b, title: `Grid to Battery: ${formatKWh(g2b)}` },
      { value: g2l, color: SOLUTION_COLORS.g2l, title: `Grid to Load: ${formatKWh(g2l)}` },
      { value: b2l, color: SOLUTION_COLORS.b2l, title: `Battery to Load: ${formatKWh(b2l)}` },
      { value: b2g, color: SOLUTION_COLORS.b2g, title: `Battery to Grid: ${formatKWh(b2g)}` },
    ]
  );
}

function updateEvSummary(els, summary) {
  if (!els.evSummaryBlock) return;

  const total = Number(summary?.evChargeTotal_kWh) || 0;
  if (total <= 0) {
    els.evSummaryBlock.classList.add("hidden");
    setText(els.sumEvGrid, "—");
    setText(els.sumEvPv, "—");
    setText(els.sumEvBatt, "—");
    setText(els.sumEvTotal, "—");
    return;
  }

  els.evSummaryBlock.classList.remove("hidden");
  const fromGrid = Number(summary.evChargeFromGrid_kWh) || 0;
  const fromPv   = Number(summary.evChargeFromPv_kWh) || 0;
  const fromBatt = Number(summary.evChargeFromBattery_kWh) || 0;

  setText(els.sumEvGrid, formatKWh(fromGrid));
  setText(els.sumEvPv, formatKWh(fromPv));
  setText(els.sumEvBatt, formatKWh(fromBatt));
  setText(els.sumEvTotal, formatKWh(total));

  updateStackedBarContainer(
    document.getElementById("ev-split-bar"),
    total,
    [
      { value: fromGrid, color: SOLUTION_COLORS.g2ev,  title: `Grid: ${formatKWh(fromGrid)}` },
      { value: fromBatt, color: SOLUTION_COLORS.b2ev,  title: `Battery: ${formatKWh(fromBatt)}` },
      { value: fromPv,   color: SOLUTION_COLORS.pv2ev, title: `PV: ${formatKWh(fromPv)}` },
    ]
  );
}

function updateRebalanceStatus(els, status) {
  if (!els.rebalanceStatus || !els.rebalanceStatusRow) return;
  if (!status || status === 'disabled') {
    els.rebalanceStatusRow.classList.add('hidden');
    return;
  }
  els.rebalanceStatusRow.classList.remove('hidden');
  if (status === 'active') {
    els.rebalanceStatus.textContent = 'Active';
    els.rebalanceStatus.className = 'text-sm font-medium text-emerald-600 dark:text-emerald-400';
  } else {
    els.rebalanceStatus.textContent = 'Scheduled';
    els.rebalanceStatus.className = 'text-sm font-medium text-sky-600 dark:text-sky-400';
  }
}

export function updateTerminalCustomUI(els) {
  const isCustom = els.terminal?.value === "custom";
  if (els.terminalCustom) els.terminalCustom.disabled = !isCustom;
}


// ---------- Helpers ----------

// Helper to update specific bar elements (legacy support for Load Split if we want, or unified)
export function updateStackedBarContainer(container, total, segments) {
  if (!container) return;
  container.innerHTML = ""; // Clear for simplicity (or diff if performance needed, but this is infrequent)

  if (total <= 0) return;

  segments.forEach(seg => {
    const pct = (seg.value / total) * 100;
    if (pct <= 0) return; // skip empty

    const el = document.createElement("div");
    el.style.height = "100%";
    el.style.width = `${pct}%`;
    el.style.backgroundColor = seg.color;
    if (seg.title) el.title = seg.title;
    container.appendChild(el);
  });
}


// small utils
function setIfDef(el, v) {
  if (!el) return;
  if (v === 0) {
    if ("value" in el) el.value = "0";
    else el.textContent = "0";
    return;
  }
  if (v == null || (typeof v === "string" && v.length === 0)) return;
  const s = String(v);
  if ("value" in el) el.value = s;
  else el.textContent = s;
}

function num(val) {
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function setText(el, txt) {
  if (!el) return;
  if (el.textContent === txt) return;

  // Clear any in-flight fade
  if (el._fadeTimer) clearTimeout(el._fadeTimer);

  el.style.transition = 'opacity 0.15s ease';
  el.classList.add('value-updating');
  el._fadeTimer = setTimeout(() => {
    if (el.isConnected) {
      el.textContent = txt;
      el.classList.remove('value-updating');
    }
    el._fadeTimer = null;
  }, 150);
}

export function formatKWh(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) < 0.005) return "0.00 kWh";
  return `${n.toFixed(2)} kWh`;
}

function formatCentsPerKWh(v) {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(2)} c€/kWh`;
}

function formatTippingPoint(v, symbol) {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${symbol} ${n.toFixed(2)} c€`;
}
