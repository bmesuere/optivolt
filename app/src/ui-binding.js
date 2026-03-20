const $ = (sel) => document.querySelector(sel);

export function getElements() {
  return {
    // actions
    run: $("#run"),
    updateDataBeforeRun: $("#update-data-before-run"),
    pushToVictron: $("#push-to-victron"),
    sourcePrices: $("#source-prices"),
    sourceLoad: $("#source-load"),
    sourcePv: $("#source-pv"),
    sourceSoc: $("#source-soc"),
    rebalanceEnabled: $("#rebalance-enabled"),
    rebalanceHoldHours: $("#rebalance-hold-hours"),

    // numeric inputs
    step: $("#step"),
    cap: $("#cap"),
    minsoc: $("#minsoc"),
    maxsoc: $("#maxsoc"),
    pchg: $("#pchg"),
    pdis: $("#pdis"),
    gimp: $("#gimp"),
    gexp: $("#gexp"),
    etaC: $("#etaC"),
    etaD: $("#etaD"),
    bwear: $("#bwear"),
    idleDrain: $("#idle-drain"),
    terminal: $("#terminal"),
    terminalCustom: $("#terminal-custom"),

    // plan metadata
    planSocNow: $("#plan-soc-now"),
    planTsStart: $("#plan-ts-start"),

    // charts + status
    flows: $("#flows"),
    soc: $("#soc"),
    prices: $("#prices"),
    loadpv: $("#loadpv"),
    table: $("#table"),
    tableKwh: $("#table-kwh"),
    tableUnit: $("#table-unit"),
    status: $("#status"),

    // summary fields
    sumLoad: $("#sum-load-kwh"),
    sumPv: $("#sum-pv-kwh"),
    sumLoadGrid: $("#sum-load-grid-kwh"),
    sumLoadBatt: $("#sum-load-batt-kwh"),
    sumLoadPv: $("#sum-load-pv-kwh"),
    avgImport: $("#avg-import-cent"),
    gridBatteryTp: $("#tipping-point-cent"),
    gridChargeTp: $("#grid-charge-point-cent"),
    batteryExportTp: $("#export-point-cent"),
    rebalanceStatus: $("#rebalance-status"),
    rebalanceStatusRow: $("#rebalance-status-row"),

    // VRM section
    vrmFetchSettings: $("#vrm-fetch-settings"),

    // Home Assistant connection (Settings tab)
    haUrl: $("#pred-ha-url"),
    haToken: $("#pred-ha-token"),
    haSettingsGroup: $("#pred-ha-settings-group"),

    // EV Charging (Settings tab)
    evEnabled: $("#ev-enabled"),
    evMinChargeCurrent: $("#ev-min-charge-current"),
    evMaxChargeCurrent: $("#ev-max-charge-current"),
    evBatteryCapacity: $("#ev-battery-capacity"),
    evSocSensor: $("#ev-soc-sensor"),
    evPlugSensor: $("#ev-plug-sensor"),
    evSocValue: $("#ev-soc-value"),
    evPlugValue: $("#ev-plug-value"),
  };
}

export function wireGlobalInputs(els, { onInput, onRun, updateTerminalCustomUI }) {
  // Auto-save whenever anything changes (except table toggler and run options)
  for (const el of document.querySelectorAll("input, select, textarea")) {
    if (el === els.tableKwh) continue;
    if (el === els.updateDataBeforeRun) continue; // Checkbox doesn't trigger auto-save
    if (el === els.pushToVictron) continue; // Checkbox doesn't trigger auto-save
    if (el.dataset.predictionsOnly) continue; // Predictions tab inputs handled separately
    el.addEventListener("input", onInput);
    el.addEventListener("change", onInput);
  }

  els.terminal?.addEventListener("change", updateTerminalCustomUI);
  updateTerminalCustomUI();

  // Manual recompute
  els.run?.addEventListener("click", onRun);

  // Units toggle recompute
  els.tableKwh?.addEventListener("change", onRun);

  // Keyboard shortcut: Ctrl+Enter (or Cmd+Enter) to Recompute
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      // Visual feedback via focus, then click
      els.run?.focus();
      els.run?.click();
    }
  });
}

export function wireVrmSettingInput(els, { onRefresh }) {
  els.vrmFetchSettings?.addEventListener("click", onRefresh);
}

