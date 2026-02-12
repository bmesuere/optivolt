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
    dessAlgorithm: $("#dess-algorithm"),

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
    loadSplitGridBar: $("#load-split-grid-bar"),
    loadSplitBattBar: $("#load-split-batt-bar"),
    loadSplitPvBar: $("#load-split-pv-bar"),
    avgImport: $("#avg-import-cent"),
    gridBatteryTp: $("#tipping-point-cent"),
    gridChargeTp: $("#grid-charge-point-cent"),
    batteryExportTp: $("#export-point-cent"),

    // VRM section
    vrmFetchSettings: $("#vrm-fetch-settings"),

    // System settings card
    systemSettingsBody: $("#system-settings-body"),
    systemSettingsToggle: $("#system-settings-toggle"),
    systemSettingsToggleIcon: $("#system-settings-toggle-icon"),
    systemSettingsHeader: $("#system-settings-header"),
  };
}

export function wireGlobalInputs(els, { onInput, onRun, updateTerminalCustomUI }) {
  // Auto-save whenever anything changes (except table toggler and run options)
  for (const el of document.querySelectorAll("input, select, textarea")) {
    if (el === els.tableKwh) continue;
    if (el === els.updateDataBeforeRun) continue; // Checkbox doesn't trigger auto-save
    if (el === els.pushToVictron) continue; // Checkbox doesn't trigger auto-save
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

export function setupSystemCardCollapsible(els) {
  const body = els.systemSettingsBody;
  const toggle = els.systemSettingsToggle;
  const icon = els.systemSettingsToggleIcon;
  const header = els.systemSettingsHeader;

  if (!body || !toggle) return;

  const lgQuery = window.matchMedia("(min-width: 1024px)");
  let isExpanded = lgQuery.matches;

  const applyState = () => {
    body.classList.toggle("hidden", !isExpanded);
    toggle.setAttribute("aria-expanded", String(isExpanded));
    icon?.classList.toggle("rotate-180", !isExpanded);
    header?.classList.toggle("mb-3", isExpanded);
    header?.classList.toggle("mb-0", !isExpanded);
  };

  const syncToViewport = () => {
    isExpanded = lgQuery.matches;
    applyState();
  };

  syncToViewport();

  toggle.addEventListener("click", () => {
    if (lgQuery.matches) return;
    isExpanded = !isExpanded;
    applyState();
  });

  lgQuery.addEventListener("change", syncToViewport);
}
