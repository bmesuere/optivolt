// Import shared logic
import { buildLP } from "./lib/build-lp.js";
import { parseSolution } from "./lib/parse-solution.js";
import { VRMClient } from "./lib/vrm-api.js";
import { drawFlowsBarStackSigned, drawSocChart, drawPricesStepLines, drawLoadPvGrouped } from "./charts.js";

const STORAGE_KEY = "optivolt-config-v1";
const STORAGE_VRM_KEY = "optivolt-vrm-cred-v1";
const SYSTEM_FETCHED_KEY = "optivolt-system-settings-fetched-at";
const DEFAULT_PROXY_BASE = "https://vrm-cors-proxy.mesuerebart.workers.dev";

// ---- Defaults (match your latest example) ----
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
  bwear: $("#bwear"), terminal: $("#terminal"),

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
let vrm = new VRMClient();
let activeTimestampsMs = null;

// --- simple debounce for auto-run ---
let timer = null;
const debounceRun = () => {
  clearTimeout(timer);
  timer = setTimeout(onRun, 250);
};

// ---------------- Sidebar ordering + badges ----------------

function isVrmConfigured() {
  const { installationId, token } = snapshotVRM();
  return Boolean((installationId || "").trim() && (token || "").trim());
}
function isSystemSettingsFetched() {
  try { return !!localStorage.getItem(SYSTEM_FETCHED_KEY); } catch { return false; }
}
function setBadge(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text || "";
}
function reorderSidebar() {
  const stack = document.getElementById("sidebar-stack");
  if (!stack) return;

  const vrmOK = isVrmConfigured();
  const sysFetched = isSystemSettingsFetched();

  // Desired default order when VRM is configured
  let order = ["card-algo", "card-data", "card-system", "card-vrm"];

  // If VRM not configured → VRM first
  if (!vrmOK) order = ["card-vrm", "card-algo", "card-data", "card-system"];

  // While system settings not fetched yet (and VRM OK), keep System second
  if (vrmOK && !sysFetched) {
    const i = order.indexOf("card-system");
    if (i > -1) order.splice(i, 1);
    order.splice(1, 0, "card-system");
  }

  for (const id of order) {
    const node = document.getElementById(id);
    if (node) stack.appendChild(node);
  }

  // VRM badge
  setBadge("badge-vrm", vrmOK ? `Connected (site ${els.vrmSite?.value || "…"})` : "Not connected");
}

// -------- timeline + scheduling helpers --------

// activeTimestampsMs holds the canonical per-slot timestamps (ms since epoch)
// for the currently loaded dataset. It is either:
// - provided by VRM fetch (preferred, real-world timestamps), OR
// - synthesized later based on the Start time field or "now".

// Format a Date -> "YYYY-MM-DDTHH:MM" suitable for <input type="datetime-local">
function toLocalDatetimeLocal(dt) {
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = dt.getFullYear();
  const mm = pad(dt.getMonth() + 1);
  const dd = pad(dt.getDate());
  const HH = pad(dt.getHours());
  const MM = pad(dt.getMinutes());
  return `${yyyy}-${mm}-${dd}T${HH}:${MM}`;
}

/**
 * Build the timing hints object we pass into parseSolution().
 *
 * priority:
 * 1. If we already have a full timestamps array from VRM (activeTimestampsMs),
 *    pass that as timestampsMs.
 * 2. Otherwise, if the user entered a Start time in the form (els.tsStart),
 *    parse that into startMs.
 * 3. Always pass stepMin so parseSolution can synthesize a full array.
 */
function buildTimingHints(cfg) {
  const hints = {
    timestampsMs: null,
    startMs: null,
    stepMin: Number(cfg.stepSize_m) || 15
  };

  // 1. Prefer a full VRM-derived timeline if it matches our data length.
  if (Array.isArray(activeTimestampsMs) &&
    activeTimestampsMs.length === cfg.load_W.length) {
    hints.timestampsMs = activeTimestampsMs.slice();
    return hints;
  }

  // 2. Fall back to the Start time input.
  if (els.tsStart && els.tsStart.value) {
    const parsed = new Date(els.tsStart.value);
    if (!isNaN(parsed.getTime())) {
      hints.startMs = parsed.getTime();
    }
  }

  return hints;
}

/**
 * Convenience wrapper so onRun() stays clean.
 * Calls parseSolution(result, cfg, hints) from lib,
 * updates activeTimestampsMs from the returned canonical timestamps,
 * and returns { rows, timestampsMs }.
 */
function runParseSolutionWithTiming(result, cfg) {
  const hints = buildTimingHints(cfg);
  const { rows, timestampsMs } = parseSolution(result, cfg, hints);
  activeTimestampsMs = timestampsMs.slice(); // keep canonical timeline synced
  return { rows, timestampsMs };
}


// ---------- Boot ----------
boot();

async function boot() {
  // Hydrate UI from storage or defaults
  const urlCfg = decodeConfigFromQuery();
  hydrateUI(urlCfg || loadFromStorage() || DEFAULTS);

  // Auto-save whenever anything changes
  for (const el of document.querySelectorAll("input, select, textarea")) {
    el.addEventListener("input", () => { saveToStorage(snapshotUI()); debounceRun(); });
    el.addEventListener("change", () => { saveToStorage(snapshotUI()); debounceRun(); });
  }

  // Manual recompute
  els.run?.addEventListener("click", onRun);

  // Load VRM creds from storage (separate secret store)
  hydrateVRM(loadVRMFromStorage());

  // Save VRM creds when fields change
  for (const el of [els.vrmSite, els.vrmToken, els.vrmProxy]) {
    el?.addEventListener("input", () => { saveVRMToStorage(snapshotVRM()); reorderSidebar(); });
    el?.addEventListener("change", () => { saveVRMToStorage(snapshotVRM()); reorderSidebar(); });
  }

  // VRM actions
  els.vrmClear?.addEventListener("click", () => {
    clearVRMStorage();
    hydrateVRM({ installationId: "", token: "" });
    setSystemFetched(false);
    reorderSidebar();
  });

  els.vrmFetchSettings?.addEventListener("click", onFetchVRMSettings);
  els.vrmFetchForecasts?.addEventListener("click", onFetchVRMForecasts);

  // Units toggle recompute
  els.tableKwh?.addEventListener("change", () => {
    saveToStorage(snapshotUI());
    onRun();
  });

  // Restore defaults
  els.restore?.addEventListener("click", () => {
    hydrateUI(DEFAULTS);
    saveToStorage(DEFAULTS);
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
  reorderSidebar();

  // Initial compute
  await onRun();
}

// ---------- Storage helpers ----------
function saveToStorage(obj) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(obj)); } catch { }
}
function loadFromStorage() {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}
function saveVRMToStorage(obj) {
  try { localStorage.setItem(STORAGE_VRM_KEY, JSON.stringify(obj)); } catch { }
}
function loadVRMFromStorage() {
  try { const s = localStorage.getItem(STORAGE_VRM_KEY); return s ? JSON.parse(s) : null; } catch { return null; }
}
function clearVRMStorage() {
  try { localStorage.removeItem(STORAGE_VRM_KEY); } catch { }
}
function snapshotVRM() {
  return {
    installationId: (els.vrmSite?.value || "").trim(),
    token: (els.vrmToken?.value || "").trim(),
    proxyBaseURL: (els.vrmProxy?.value || "").trim(),
  };
}
function hydrateVRM(obj) {
  const installationId = obj?.installationId || "";
  const token = obj?.token || "";
  // default proxy if empty in storage
  const proxyBaseURL = (obj?.proxyBaseURL || DEFAULT_PROXY_BASE);

  if (els.vrmSite) els.vrmSite.value = installationId;
  if (els.vrmToken) els.vrmToken.value = token;
  if (els.vrmProxy) els.vrmProxy.value = proxyBaseURL;

  // IMPORTANT: set baseURL from proxyBaseURL (client will add /v2)
  vrm.setBaseURL(proxyBaseURL);
  vrm.setAuth({ installationId, token });

  reorderSidebar();
}

// --- URL share helpers (URL-safe base64 of the snapshot JSON) ---
function encodeConfigToQuery(obj) {
  const json = JSON.stringify(obj);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  const urlSafe = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const u = new URL(location.href);
  u.searchParams.set("cfg", urlSafe);
  return u.toString();
}
function decodeConfigFromQuery() {
  const u = new URL(location.href);
  const cfg = u.searchParams.get("cfg");
  if (!cfg) return null;
  try {
    const b64 = cfg.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(escape(atob(b64)));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function onFetchVRMSettings() {
  try {
    hydrateVRM(snapshotVRM()); // ensure client has latest
    els.status.textContent = "Fetching VRM settings…";
    const s = await vrm.fetchDynamicEssSettings();

    // Map settings into the form where reasonable (keep user's current values if VRM returns 0/null)
    setIfFinite(els.cap, s.batteryCapacity_Wh);
    setIfFinite(els.pdis, s.dischargePower_W || s.limits?.batteryDischargeLimit_W);
    setIfFinite(els.pchg, s.chargePower_W || s.limits?.batteryChargeLimit_W);
    setIfFinite(els.gimp, s.maxPowerFromGrid_W || s.limits?.gridImportLimit_W);
    setIfFinite(els.gexp, s.maxPowerToGrid_W || s.limits?.gridExportLimit_W);

    // Battery cost → c€/kWh
    if (Number.isFinite(s.batteryCosts_cents_per_kWh)) {
      els.bwear.value = s.batteryCosts_cents_per_kWh;
    }

    saveToStorage(snapshotUI());
    els.status.textContent = "Settings loaded from VRM.";
    setSystemFetched(true);
    reorderSidebar();
    await onRun();
  } catch (err) {
    console.error(err);
    els.status.textContent = `VRM error: ${err.message}`;
  }
}
function setIfFinite(input, v) { if (Number.isFinite(v) && input) input.value = String(v); }

async function onFetchVRMForecasts() {
  try {
    hydrateVRM(snapshotVRM()); // ensure client has latest credentials
    els.status.textContent = "Fetching VRM forecasts, prices & SoC…";

    // Ask VRM for forecasts + prices using its built-in horizon logic
    const [fc, pr, soc] = await Promise.all([
      vrm.fetchForecasts(),
      vrm.fetchPrices(),
      typeof vrm.fetchCurrentSoc === "function" ? vrm.fetchCurrentSoc() : Promise.resolve(null)
    ]);

    // If VRM returned explicit timestamps, adopt them as canonical.
    if (Array.isArray(fc.timestamps) && fc.timestamps.length > 0) {
      activeTimestampsMs = fc.timestamps.slice();

      // Write the first timestamp back into the Start time field so we persist it
      if (els.tsStart) {
        const firstMs = fc.timestamps[0];
        els.tsStart.value = toLocalDatetimeLocal(new Date(firstMs));
      }
    } else {
      activeTimestampsMs = null;
    }

    // Force our step size to match VRM dataset (usually 15 min)
    if (els.step) els.step.value = fc.step_minutes || 15;

    // Fill in the per-slot series from VRM
    if (els.tLoad) els.tLoad.value = (fc.load_W || []).join(",");
    if (els.tPV) els.tPV.value = (fc.pv_W || []).join(",");
    if (els.tIC) els.tIC.value = (pr.importPrice_cents_per_kwh || []).join(",");
    if (els.tEC) els.tEC.value = (pr.exportPrice_cents_per_kwh || []).join(",");

    // If SoC is available, set it in the Initial SoC input
    if (soc && Number.isFinite(soc.soc_percent)) {
      const clamped = Math.max(0, Math.min(100, Number(soc.soc_percent)));
      if (els.initsoc) els.initsoc.value = String(clamped);
    }

    // Persist the full UI state (now including tsStart) in localStorage
    saveToStorage(snapshotUI());

    els.status.textContent = soc && Number.isFinite(soc.soc_percent)
      ? `Forecasts, prices & SoC loaded from VRM (SoC ${soc.soc_percent}%).`
      : "Forecasts & prices loaded from VRM (SoC unavailable).";

    await onRun();
  } catch (err) {
    console.error(err);
    els.status.textContent = `VRM error: ${err.message}`;
  }
}


// Take current UI and return a plain object (including textarea strings)
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

    load_W_txt: els.tLoad?.value ?? "",
    pv_W_txt: els.tPV?.value ?? "",
    importPrice_txt: els.tIC?.value ?? "",
    exportPrice_txt: els.tEC?.value ?? "",
    tsStart: els.tsStart?.value || "",
    tableShowKwh: !!els.tableKwh?.checked,
  };
}

// Write an object into the UI (numbers + textarea strings)
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

  if (els.tLoad) els.tLoad.value = obj.load_W_txt ?? DEFAULTS.load_W_txt;
  if (els.tPV) els.tPV.value = obj.pv_W_txt ?? DEFAULTS.pv_W_txt;
  if (els.tIC) els.tIC.value = obj.importPrice_txt ?? DEFAULTS.importPrice_txt;
  if (els.tEC) els.tEC.value = obj.exportPrice_txt ?? DEFAULTS.exportPrice_txt;
  if (els.tsStart) els.tsStart.value = obj.tsStart || "";
  if (els.tableKwh) els.tableKwh.checked = !!(obj.tableShowKwh ?? DEFAULTS.tableShowKwh);
}

function setSystemFetched(v = true) {
  try {
    if (v) localStorage.setItem(SYSTEM_FETCHED_KEY, "1");
    else localStorage.removeItem(SYSTEM_FETCHED_KEY);
  } catch { }
}

// ---------- Main compute ----------
async function onRun() {
  try {
    const cfg = uiToConfig();
    const lpText = buildLP(cfg);

    // keep a copy in storage whenever we run (includes tsStart etc.)
    saveToStorage(snapshotUI());

    const result = highs.solve(lpText);

    // report solver status + cost
    if (els.objective) {
      els.objective.textContent = Number.isFinite(result.ObjectiveValue)
        ? Number(result.ObjectiveValue).toFixed(2)
        : "—";
    }
    if (els.status) els.status.textContent = ` ${result.Status}`;

    // parseSolution (library) with proper timing hints
    const { rows, timestampsMs } = runParseSolutionWithTiming(result, cfg);

    // table + charts now use the canonical timestampsMs
    renderTable(rows, cfg, timestampsMs);

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
  };
}

function renderTable(rows, cfg, timestampsMs) {
  // read current unit toggle once
  const showKwh = !!els.tableKwh?.checked;

  // battery capacity (for SoC%)
  const cap = Math.max(1e-9, Number(cfg?.batteryCapacity_Wh ?? 20480));

  // slot duration for W→kWh conversion
  const h = Math.max(0.000001, Number(cfg?.stepSize_m ?? 60) / 60); // hours per slot
  const W2kWh = (x) => (Number(x) || 0) * h / 1000;

  // build human-readable time labels
  const timesDisp = timestampsMs.map(ms => {
    const dt = new Date(ms);
    const HH = String(dt.getHours()).padStart(2, "0");
    const MM = String(dt.getMinutes()).padStart(2, "0");

    if (dt.getMinutes() === 0) {
      if (dt.getHours() === 0) {
        const dd = String(dt.getDate()).padStart(2, "0");
        const mm = String(dt.getMonth() + 1).padStart(2, "0");
        return `${dd}/${mm}`;
      }
      return `${HH}:00`;
    }
    return `${HH}:${MM}`;
  });

  const cols = [
    {
      key: "time",
      headerHtml: "Time",
      fmt: (_, idx) => timesDisp[idx]
    },

    {
      key: "load",
      headerHtml: "Exp.<br>load",
      fmt: (x) => fmtEnergy(x, { dash: false }),
      tip: "Expected Load"
    },
    {
      key: "pv",
      headerHtml: "Exp.<br>PV",
      fmt: (x) => fmtEnergy(x, { dash: false }),
      tip: "Expected PV"
    },

    {
      key: "ic",
      headerHtml: "Import<br>cost",
      fmt: dec2Thin
    },
    {
      key: "ec",
      headerHtml: "Export<br>cost",
      fmt: dec2Thin
    },

    {
      key: "g2l",
      headerHtml: "g2l",
      fmt: (x) => fmtEnergy(x, { dash: true }),
      tip: "Grid → Load"
    },
    {
      key: "g2b",
      headerHtml: "g2b",
      fmt: (x) => fmtEnergy(x, { dash: true }),
      tip: "Grid → Battery"
    },
    {
      key: "pv2l",
      headerHtml: "pv2l",
      fmt: (x) => fmtEnergy(x, { dash: true }),
      tip: "Solar → Load"
    },
    {
      key: "pv2b",
      headerHtml: "pv2b",
      fmt: (x) => fmtEnergy(x, { dash: true }),
      tip: "Solar → Battery"
    },
    {
      key: "pv2g",
      headerHtml: "pv2g",
      fmt: (x) => fmtEnergy(x, { dash: true }),
      tip: "Solar → Grid"
    },
    {
      key: "b2l",
      headerHtml: "b2l",
      fmt: (x) => fmtEnergy(x, { dash: true }),
      tip: "Battery → Load"
    },
    {
      key: "b2g",
      headerHtml: "b2g",
      fmt: (x) => fmtEnergy(x, { dash: true }),
      tip: "Battery → Grid"
    },

    {
      key: "imp",
      headerHtml: "Grid<br>import",
      fmt: (x) => fmtEnergy(x, { dash: true }),
      tip: "Grid Import"
    },
    {
      key: "exp",
      headerHtml: "Grid<br>export",
      fmt: (x) => fmtEnergy(x, { dash: true }),
      tip: "Grid Export"
    },

    {
      key: "soc",
      headerHtml: "SoC",
      fmt: (w) => pct0(w / cap) + "%"
    }
  ];

  const thead = `
    <thead>
      <tr class="align-bottom">
        ${cols.map(c =>
    `<th class="px-2 py-1 border-b font-medium text-right align-bottom" ${c.tip ? `title="${escapeHtml(c.tip)}"` : ""}>${c.headerHtml}</th>`
  ).join("")}
      </tr>
    </thead>`;

  const tbody = `
  <tbody>
    ${rows.map((r, ri) => {
    // Determine if this row is a midnight boundary.
    const timeLabel = cols[0].fmt(null, ri); // "time" column
    const isMidnightRow = /^\d{2}\/\d{2}$/.test(timeLabel);

    const tds = cols.map(c => {
      let displayVal;
      if (c.key === "time") {
        displayVal = timeLabel;
      } else {
        displayVal = c.fmt(r[c.key], ri);
      }

      return `<td class="px-2 py-1 border-b text-right font-mono tabular-nums ${isMidnightRow ? "font-semibold" : ""}">${displayVal}</td>`;
    }).join("");

    return `<tr>${tds}</tr>`;
  }).join("")}
  </tbody>`;

  if (els.table) els.table.innerHTML = thead + tbody;

  if (els.tableUnit) {
    els.tableUnit.textContent = `Units: ${showKwh ? "kWh" : "W"}`;
  }

  // helpers
  function fmtEnergy(x, { dash = false } = {}) {
    const raw = Number(x) || 0;
    if (showKwh) {
      const val = W2kWh(raw);
      if (dash && Math.abs(val) < 1e-12) return "–";
      return dec2Thin(val);
    } else {
      const n = Math.round(raw);
      if (dash && n === 0) return "–";
      return intThin(n);
    }
  }

  function intThin(x) {
    return groupThin(Math.round(Number(x) || 0));
  }

  function dec2Thin(x) {
    const n = Number(x);
    if (!Number.isFinite(n)) return "";
    const s = n.toFixed(2);
    const [i, f] = s.split(".");
    return `${groupThin(i)}.${f}`;
  }

  function pct0(x) {
    const n = (Number(x) || 0) * 100;
    return groupThin(Math.round(n));
  }

  function groupThin(numOrStr) {
    const s = String(numOrStr);
    const neg = s.startsWith("-") ? "-" : "";
    const body = neg ? s.slice(1) : s;
    const parts = body.split(".");
    const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");
    return parts.length > 1 ? `${neg}${intPart}.${parts[1]}` : `${neg}${intPart}`;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, m => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#039;"
    }[m]));
  }
}

// ---------- small utils ----------
function parseSeries(s) { return (s || "").split(/[\s,]+/).map(Number).filter((x) => Number.isFinite(x)); }
function num(val, fallback) { const n = Number(val); return Number.isFinite(n) ? n : fallback; }
