// Import shared logic
import { buildLP } from "./lib/build-lp.js";
import { parseSolution } from "./lib/parse-solution.js";

import { drawFlowsBarStackSigned, drawSocChart, drawPricesStepLines, drawLoadPvGrouped } from "./app/charts.js";
import { renderTable } from "./app/table.js";
import { runParseSolutionWithTiming, adoptTimelineFromForecast } from "./app/timeline.js";
import {
  STORAGE_KEY,
  saveToStorage, loadFromStorage, removeFromStorage, setSystemFetched
} from "./app/storage.js";
import { encodeConfigToQuery, decodeConfigFromQuery } from "./app/share.js";
import { reorderSidebar } from "./app/sidebar.js";
import { debounce } from "./app/utils.js";
import { VRMManager } from "./app/vrm.js";

// ---- Defaults ----
const DEFAULTS = {
  stepSize_m: 60,
  batteryCapacity_Wh: 20480,
  minSoc_percent: 20,
  maxSoc_percent: 100,
  initialSoc_percent: 20,
  maxChargePower_W: 3600,
  maxDischargePower_W: 4000,
  maxGridImport_W: 2500,
  maxGridExport_W: 5000,
  chargeEfficiency_percent: 95,
  dischargeEfficiency_percent: 95,
  batteryCost_cent_per_kWh: 2,
  terminalSocValuation: "zero",
  terminalSocCustomPrice_cents_per_kWh: 0,
  tableShowKwh: false,

  load_W_txt: "280,250,360,420,1230,190,190,490,490,360,670,1750,340,640,360,880,650,900,540,500,480,480,480,290",
  pv_W_txt: "0,0,0,0,0,0,0,0,40,120,480,700,920,910,940,670,520,290,60,0,0,0,0,0",
  importPrice_txt: "22.258065600000002,21.642862800000003,21.0892884,21.10875,20.760603600000003,20.515171200000005,22.302394800000002,23.395488,23.527394400000006,29.488050000000005,27.600274800000005,24.1653024,23.696061600000004,23.5122576,22.264552800000004,22.5337716,21.789906000000002,22.3391556,29.704290000000004,44.90920560000001,33.8550168,28.9160952,25.5719436,23.5284756",
  exportPrice_txt: "6.45074,5.893119999999999,5.391359999999999,5.409,5.09344,4.870979999999999,6.49092,7.481700000000001,7.60126,13.004,11.292919999999999,8.179459999999999,7.754140000000001,7.58754,6.456619999999999,6.700640000000001,6.0264,6.524239999999999,13.200000000000001,26.98174,16.96222,12.48558,9.45444,7.602239999999999"
};

const $ = (sel) => document.querySelector(sel);
const els = {
  run: $("#run"),
  restore: $("#restore"),
  share: $("#share"),

  // numeric inputs
  step: $("#step"), cap: $("#cap"),
  minsoc: $("#minsoc"), maxsoc: $("#maxsoc"), initsoc: $("#initsoc"),
  pchg: $("#pchg"), pdis: $("#pdis"),
  gimp: $("#gimp"), gexp: $("#gexp"),
  etaC: $("#etaC"), etaD: $("#etaD"),
  bwear: $("#bwear"), terminal: $("#terminal"), terminalCustom: $("#terminal-custom"),

  // textareas
  tLoad: $("#ts-load"), tPV: $("#ts-pv"), tIC: $("#ts-ic"), tEC: $("#ts-ec"), tsStart: $("#ts-start"),

  // charts + status
  flows: $("#flows"), soc: $("#soc"), prices: $("#prices"), loadpv: $("#loadpv"),
  table: $("#table"),
  tableKwh: $("#table-kwh"),
  tableUnit: $("#table-unit"),
  status: $("#status"), objective: $("#objective"),

  // VRM section
  vrmSite: $("#vrm-site"),
  vrmToken: $("#vrm-token"),
  vrmFetchSettings: $("#vrm-fetch-settings"),
  vrmFetchForecasts: $("#vrm-fetch-forecasts"),
  vrmClear: $("#vrm-clear"),
  vrmProxy: $("#vrm-proxy"),
};

let highs = null;
const vrmMgr = new VRMManager(); // class-based manager
const debounceRun = debounce(onRun, 250);

// ---------- Boot ----------
boot();

async function boot() {
  const urlCfg = decodeConfigFromQuery();
  hydrateUI(urlCfg || loadFromStorage(STORAGE_KEY) || DEFAULTS);

  // Auto-save whenever anything changes
  for (const el of document.querySelectorAll("input, select, textarea")) {
    el.addEventListener("input", () => { saveToStorage(STORAGE_KEY, snapshotUI()); debounceRun(); });
    el.addEventListener("change", () => { saveToStorage(STORAGE_KEY, snapshotUI()); debounceRun(); });
  }

  els.terminal?.addEventListener("change", updateTerminalCustomUI);
  updateTerminalCustomUI();

  // Manual recompute
  els.run?.addEventListener("click", onRun);

  // VRM: hydrate from storage into inputs + client
  vrmMgr.hydrateFromStorage(els);

  // Save VRM creds when fields change
  for (const el of [els.vrmSite, els.vrmToken, els.vrmProxy]) {
    el?.addEventListener("input", () => {
      vrmMgr.saveFromEls(els);
      reorderSidebar({ isVrmConfigured: () => vrmMgr.isConfigured(els), vrmSiteValue: els.vrmSite?.value });
    });
    el?.addEventListener("change", () => {
      vrmMgr.saveFromEls(els);
      reorderSidebar({ isVrmConfigured: () => vrmMgr.isConfigured(els), vrmSiteValue: els.vrmSite?.value });
    });
  }

  // VRM actions
  els.vrmClear?.addEventListener("click", () => {
    vrmMgr.clearStorage();
    vrmMgr.hydrate(els, { installationId: "", token: "" }); // clears inputs + client
    setSystemFetched(false);
    reorderSidebar({ isVrmConfigured: () => vrmMgr.isConfigured(els), vrmSiteValue: els.vrmSite?.value });
  });

  els.vrmFetchSettings?.addEventListener("click", onFetchVRMSettings);
  els.vrmFetchForecasts?.addEventListener("click", onFetchVRMForecasts);

  // Units toggle recompute
  els.tableKwh?.addEventListener("change", () => {
    saveToStorage(STORAGE_KEY, snapshotUI());
    onRun();
  });

  // Restore defaults
  els.restore?.addEventListener("click", () => {
    hydrateUI(DEFAULTS);
    saveToStorage(STORAGE_KEY, DEFAULTS);
    onRun();
  });

  // Share current config via URL (copied to clipboard)
  els.share?.addEventListener("click", async () => {
    try {
      const link = encodeConfigToQuery(snapshotUI());
      await navigator.clipboard.writeText(link);
      const prev = els.share.textContent;
      els.share.textContent = "Copied!";
      setTimeout(() => (els.share.textContent = prev), 1200);
    } catch {
      window.open(encodeConfigToQuery(snapshotUI()), "_blank");
    }
  });

  // Initialize HiGHS via global UMD factory `Module`
  // eslint-disable-next-line no-undef
  highs = await Module({
    locateFile: (file) => "https://lovasoa.github.io/highs-js/" + file
  });
  els.status.textContent = "Solver loaded.";

  // Initial sidebar order & badges
  reorderSidebar({ isVrmConfigured: () => vrmMgr.isConfigured(els), vrmSiteValue: els.vrmSite?.value });

  // Initial compute
  await onRun();
}

async function onFetchVRMSettings() {
  try {
    vrmMgr.refreshClientFromEls(els); // make sure client uses current inputs
    els.status.textContent = "Fetching VRM settings…";
    const s = await vrmMgr.client.fetchDynamicEssSettings();

    setIfFinite(els.cap, s.batteryCapacity_Wh);
    setIfFinite(els.pdis, s.dischargePower_W || s.limits?.batteryDischargeLimit_W);
    setIfFinite(els.pchg, s.chargePower_W || s.limits?.batteryChargeLimit_W);
    setIfFinite(els.gimp, s.maxPowerFromGrid_W || s.limits?.gridImportLimit_W);
    setIfFinite(els.gexp, s.maxPowerToGrid_W || s.limits?.gridExportLimit_W);

    if (Number.isFinite(s.batteryCosts_cents_per_kWh)) {
      els.bwear.value = s.batteryCosts_cents_per_kWh;
    }

    saveToStorage(STORAGE_KEY, snapshotUI());
    els.status.textContent = "Settings loaded from VRM.";
    setSystemFetched(true);
    reorderSidebar({ isVrmConfigured: () => vrmMgr.isConfigured(els), vrmSiteValue: els.vrmSite?.value });
    await onRun();
  } catch (err) {
    console.error(err);
    els.status.textContent = `VRM error: ${err.message}`;
  }
}
function setIfFinite(input, v) { if (Number.isFinite(v) && input) input.value = String(v); }

async function onFetchVRMForecasts() {
  try {
    vrmMgr.refreshClientFromEls(els); // ensure client has latest credentials
    els.status.textContent = "Fetching VRM forecasts, prices & SoC…";

    const [fc, pr, soc] = await Promise.all([
      vrmMgr.client.fetchForecasts(),
      vrmMgr.client.fetchPrices(),
      typeof vrmMgr.client.fetchCurrentSoc === "function" ? vrmMgr.client.fetchCurrentSoc() : Promise.resolve(null)
    ]);

    const { adopted, firstInputValue } = adoptTimelineFromForecast(fc);
    if (adopted && els.tsStart && firstInputValue) {
      els.tsStart.value = firstInputValue;
    }

    if (els.step) els.step.value = fc.step_minutes || 15;

    if (els.tLoad) els.tLoad.value = (fc.load_W || []).join(",");
    if (els.tPV) els.tPV.value = (fc.pv_W || []).join(",");
    if (els.tIC) els.tIC.value = (pr.importPrice_cents_per_kwh || []).join(",");
    if (els.tEC) els.tEC.value = (pr.exportPrice_cents_per_kwh || []).join(",");

    if (soc && Number.isFinite(soc.soc_percent)) {
      const clamped = Math.max(0, Math.min(100, Number(soc.soc_percent)));
      if (els.initsoc) els.initsoc.value = String(clamped);
    }

    saveToStorage(STORAGE_KEY, snapshotUI());

    els.status.textContent = soc && Number.isFinite(soc.soc_percent)
      ? `Forecasts, prices & SoC loaded from VRM (SoC ${soc.soc_percent}%).`
      : "Forecasts & prices loaded from VRM (SoC unavailable).";

    await onRun();
  } catch (err) {
    console.error(err);
    els.status.textContent = `VRM error: ${err.message}`;
  }
}

// ---- UI <-> config
function snapshotUI() {
  return {
    stepSize_m: num(els.step?.value, DEFAULTS.stepSize_m),
    batteryCapacity_Wh: num(els.cap?.value, DEFAULTS.batteryCapacity_Wh),
    minSoc_percent: num(els.minsoc?.value, DEFAULTS.minSoc_percent),
    maxSoc_percent: num(els.maxsoc?.value, DEFAULTS.maxSoc_percent),
    initialSoc_percent: num(els.initsoc?.value, DEFAULTS.initialSoc_percent),
    maxChargePower_W: num(els.pchg?.value, DEFAULTS.maxChargePower_W),
    maxDischargePower_W: num(els.pdis?.value, DEFAULTS.maxDischargePower_W),
    maxGridImport_W: num(els.gimp?.value, DEFAULTS.maxGridImport_W),
    maxGridExport_W: num(els.gexp?.value, DEFAULTS.maxGridExport_W),
    chargeEfficiency_percent: num(els.etaC?.value, DEFAULTS.chargeEfficiency_percent),
    dischargeEfficiency_percent: num(els.etaD?.value, DEFAULTS.dischargeEfficiency_percent),
    batteryCost_cent_per_kWh: num(els.bwear?.value, DEFAULTS.batteryCost_cent_per_kWh),
    terminalSocValuation: els.terminal?.value || DEFAULTS.terminalSocValuation,
    terminalSocCustomPrice_cents_per_kWh: num(els.terminalCustom?.value, DEFAULTS.terminalSocCustomPrice_cents_per_kWh),

    load_W_txt: els.tLoad?.value ?? "",
    pv_W_txt: els.tPV?.value ?? "",
    importPrice_txt: els.tIC?.value ?? "",
    exportPrice_txt: els.tEC?.value ?? "",
    tsStart: els.tsStart?.value || "",
    tableShowKwh: !!els.tableKwh?.checked,
  };
}

function hydrateUI(obj) {
  if (els.step) els.step.value = obj.stepSize_m ?? DEFAULTS.stepSize_m;
  if (els.cap) els.cap.value = obj.batteryCapacity_Wh ?? DEFAULTS.batteryCapacity_Wh;
  if (els.minsoc) els.minsoc.value = obj.minSoc_percent ?? DEFAULTS.minSoc_percent;
  if (els.maxsoc) els.maxsoc.value = obj.maxSoc_percent ?? DEFAULTS.maxSoc_percent;
  if (els.initsoc) els.initsoc.value = obj.initialSoc_percent ?? DEFAULTS.initialSoc_percent;

  if (els.pchg) els.pchg.value = obj.maxChargePower_W ?? DEFAULTS.maxChargePower_W;
  if (els.pdis) els.pdis.value = obj.maxDischargePower_W ?? DEFAULTS.maxDischargePower_W;
  if (els.gimp) els.gimp.value = obj.maxGridImport_W ?? DEFAULTS.maxGridImport_W;
  if (els.gexp) els.gexp.value = obj.maxGridExport_W ?? DEFAULTS.maxGridExport_W;

  if (els.etaC) els.etaC.value = obj.chargeEfficiency_percent ?? DEFAULTS.chargeEfficiency_percent;
  if (els.etaD) els.etaD.value = obj.dischargeEfficiency_percent ?? DEFAULTS.dischargeEfficiency_percent;

  if (els.bwear) els.bwear.value = obj.batteryCost_cent_per_kWh ?? DEFAULTS.batteryCost_cent_per_kWh;
  if (els.terminal) els.terminal.value = obj.terminalSocValuation ?? DEFAULTS.terminalSocValuation;
  if (els.terminalCustom) els.terminalCustom.value = obj.terminalSocCustomPrice_cents_per_kWh ?? DEFAULTS.terminalSocCustomPrice_cents_per_kWh;

  if (els.tLoad) els.tLoad.value = obj.load_W_txt ?? DEFAULTS.load_W_txt;
  if (els.tPV) els.tPV.value = obj.pv_W_txt ?? DEFAULTS.pv_W_txt;
  if (els.tIC) els.tIC.value = obj.importPrice_txt ?? DEFAULTS.importPrice_txt;
  if (els.tEC) els.tEC.value = obj.exportPrice_txt ?? DEFAULTS.exportPrice_txt;
  if (els.tsStart) els.tsStart.value = obj.tsStart || "";
  if (els.tableKwh) els.tableKwh.checked = !!(obj.tableShowKwh ?? DEFAULTS.tableShowKwh);

  updateTerminalCustomUI();
}

// ---------- Main compute ----------
async function onRun() {
  try {
    const cfg = uiToConfig();
    const lpText = buildLP(cfg);

    saveToStorage(STORAGE_KEY, snapshotUI());

    const result = highs.solve(lpText);

    if (els.objective) {
      els.objective.textContent = Number.isFinite(result.ObjectiveValue)
        ? Number(result.ObjectiveValue).toFixed(2)
        : "—";
    }
    if (els.status) els.status.textContent = ` ${result.Status}`;

    const { rows, timestampsMs } = runParseSolutionWithTiming(
      result,
      cfg,
      parseSolution,
      els.tsStart?.value || ""
    );

    renderTable({
      rows,
      cfg,
      timestampsMs,
      targets: { table: els.table, tableUnit: els.tableUnit },
      showKwh: !!els.tableKwh?.checked,
    });

    drawFlowsBarStackSigned(els.flows, rows, cfg.stepSize_m, timestampsMs);
    drawSocChart(els.soc, rows, cfg.batteryCapacity_Wh, cfg.stepSize_m, timestampsMs);
    drawPricesStepLines(els.prices, rows, cfg.stepSize_m, timestampsMs);
    drawLoadPvGrouped(els.loadpv, rows, cfg.stepSize_m, timestampsMs);
  } catch (err) {
    console.error(err);
    if (els.status) els.status.textContent = `Error: ${err.message}`;
  }
}

function uiToConfig() {
  const load_W = parseSeries(els.tLoad?.value);
  const pv_W = parseSeries(els.tPV?.value);
  const importPrice = parseSeries(els.tIC?.value);
  const exportPrice = parseSeries(els.tEC?.value);

  const T = Math.min(load_W.length, pv_W.length, importPrice.length, exportPrice.length);
  if (T === 0) throw new Error("No data in time series.");
  const clip = (a) => a.slice(0, T);

  return {
    load_W: clip(load_W),
    pv_W: clip(pv_W),
    importPrice: clip(importPrice),
    exportPrice: clip(exportPrice),

    stepSize_m: num(els.step?.value, DEFAULTS.stepSize_m),
    batteryCapacity_Wh: num(els.cap?.value, DEFAULTS.batteryCapacity_Wh),
    minSoc_percent: num(els.minsoc?.value, DEFAULTS.minSoc_percent),
    maxSoc_percent: num(els.maxsoc?.value, DEFAULTS.maxSoc_percent),
    initialSoc_percent: num(els.initsoc?.value, DEFAULTS.initialSoc_percent),

    maxChargePower_W: num(els.pchg?.value, DEFAULTS.maxChargePower_W),
    maxDischargePower_W: num(els.pdis?.value, DEFAULTS.maxDischargePower_W),
    maxGridImport_W: num(els.gimp?.value, DEFAULTS.maxGridImport_W),
    maxGridExport_W: num(els.gexp?.value, DEFAULTS.maxGridExport_W),
    chargeEfficiency_percent: num(els.etaC?.value, DEFAULTS.chargeEfficiency_percent),
    dischargeEfficiency_percent: num(els.etaD?.value, DEFAULTS.dischargeEfficiency_percent),
    batteryCost_cent_per_kWh: num(els.bwear?.value, DEFAULTS.batteryCost_cent_per_kWh),
    terminalSocValuation: els.terminal?.value || DEFAULTS.terminalSocValuation,
    terminalSocCustomPrice_cents_per_kWh: num(els.terminalCustom?.value, DEFAULTS.terminalSocCustomPrice_cents_per_kWh),
  };
}

function updateTerminalCustomUI() {
  const isCustom = (els.terminal?.value === "custom");
  if (els.terminalCustom) {
    els.terminalCustom.disabled = !isCustom;
  }
}

// ---------- small utils ----------
function parseSeries(s) { return (s || "").split(/[\s,]+/).map(Number).filter((x) => Number.isFinite(x)); }
function num(val, fallback) { const n = Number(val); return Number.isFinite(n) ? n : fallback; }
