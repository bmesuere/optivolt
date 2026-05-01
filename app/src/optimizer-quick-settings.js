export const QUICK_SETTING_DEFS = [
  { id: "batteryCapacity_Wh", selector: "#cap", label: "Battery capacity (Wh)", kind: "number" },
  { id: "batteryCost_cent_per_kWh", selector: "#bwear", label: "Battery cost (c€/kWh)", kind: "number" },
  { id: "minSoc_percent", selector: "#minsoc", label: "Min SoC (%)", kind: "number" },
  { id: "maxSoc_percent", selector: "#maxsoc", label: "Max SoC (%)", kind: "number" },
  { id: "maxChargePower_W", selector: "#pchg", label: "Max charge (W)", kind: "number" },
  { id: "maxDischargePower_W", selector: "#pdis", label: "Max discharge (W)", kind: "number" },
  { id: "maxGridImport_W", selector: "#gimp", label: "Max grid import (W)", kind: "number" },
  { id: "maxGridExport_W", selector: "#gexp", label: "Max grid export (W)", kind: "number" },
  { id: "chargeEfficiency_percent", selector: "#etaC", label: "Charge efficiency (%)", kind: "number" },
  { id: "dischargeEfficiency_percent", selector: "#etaD", label: "Discharge efficiency (%)", kind: "number" },
  { id: "stepSize_m", selector: "#step", label: "Step (min)", kind: "number" },
  { id: "idleDrain_W", selector: "#idle-drain", label: "Idle drain (W)", kind: "number" },
  { id: "rebalanceHoldHours", selector: "#rebalance-hold-hours", label: "Rebalance hold (h)", kind: "number" },
  {
    id: "blockFeedInOnNegativePrices",
    selector: "#block-feedin-negative-prices",
    label: "Block negative feed-in",
    kind: "checkbox",
  },
  { id: "evMinChargeCurrent_A", selector: "#ev-min-charge-current", label: "EV min current (A)", kind: "number" },
  { id: "evMaxChargeCurrent_A", selector: "#ev-max-charge-current", label: "EV max current (A)", kind: "number" },
  { id: "evBatteryCapacity_kWh", selector: "#ev-battery-capacity", label: "EV capacity (kWh)", kind: "number" },
  { id: "evChargeEfficiency_percent", selector: "#ev-charge-efficiency", label: "EV efficiency (%)", kind: "number" },
];

const FIELD_LABEL_CLASS = "block text-xs font-medium text-slate-400 dark:text-slate-500 mb-1 tracking-wide";

export function normalizeQuickSettingIds(ids, definitions = QUICK_SETTING_DEFS) {
  const allowedIds = new Set(definitions.map((def) => def.id));
  const seen = new Set();
  const result = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id !== "string" || !allowedIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function parseQuickSettingSelection(raw, definitions = QUICK_SETTING_DEFS) {
  if (Array.isArray(raw)) return normalizeQuickSettingIds(raw, definitions);
  if (typeof raw !== "string" || raw.trim() === "") return [];

  try {
    return normalizeQuickSettingIds(JSON.parse(raw), definitions);
  } catch {
    return normalizeQuickSettingIds(raw.split(",").map((id) => id.trim()), definitions);
  }
}

export function writeQuickSettingSelection(selectionInput, ids, definitions = QUICK_SETTING_DEFS) {
  if (!selectionInput) return;
  selectionInput.value = JSON.stringify(normalizeQuickSettingIds(ids, definitions));
}

export function initOptimizerQuickSettings({
  selectionInput,
  section,
  body,
  definitions = QUICK_SETTING_DEFS,
  onSelectionChange = () => {},
} = {}) {
  const doc = section?.ownerDocument || body?.ownerDocument || selectionInput?.ownerDocument || document;
  const state = {
    body,
    definitions,
    doc,
    mirrorsById: new Map(),
    pinButtonsById: new Map(),
    section,
    selectedIds: [],
    selectionInput,
    onSelectionChange,
    sourceControlsById: new Map(),
  };

  for (const def of definitions) {
    const source = doc.querySelector(def.selector);
    if (!source) continue;

    state.sourceControlsById.set(def.id, source);
    installPinButton(state, def, source, (id) => {
      const selected = state.selectedIds.includes(id)
        ? state.selectedIds.filter((item) => item !== id)
        : [...state.selectedIds, id];
      setSelectedIds(state, selected, { notify: true });
    });

    const syncMirror = () => syncMirrorFromSource(state, def.id);
    source.addEventListener("input", syncMirror);
    source.addEventListener("change", syncMirror);
  }

  function refresh() {
    const ids = parseQuickSettingSelection(state.selectionInput?.value, definitions);
    setSelectedIds(state, ids, { notify: false });
  }

  refresh();

  return {
    getSelectedIds: () => [...state.selectedIds],
    refresh,
    setSelectedIds: (ids, opts = {}) => setSelectedIds(state, ids, opts),
  };
}

function setSelectedIds(state, ids, { notify = false } = {}) {
  state.selectedIds = normalizeQuickSettingIds(ids, state.definitions);
  writeQuickSettingSelection(state.selectionInput, state.selectedIds, state.definitions);
  renderMirrors(state);
  updatePinButtons(state);
  if (notify) state.onSelectionChange([...state.selectedIds]);
}

function installPinButton(state, def, source, onToggle) {
  const label = source.closest("label");
  if (!label) return;

  const existing = label.querySelector(`[data-quick-setting-pin="${def.id}"]`);
  if (existing) {
    state.pinButtonsById.set(def.id, existing);
    return;
  }

  const isToggle = label.classList.contains("toggle");
  label.classList.add(isToggle ? "quick-setting-toggle-label" : "quick-setting-source-label");

  const button = state.doc.createElement("button");
  button.type = "button";
  button.className = "quick-setting-pin";
  button.dataset.quickSettingPin = def.id;
  button.innerHTML = pinIconSvg();
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onToggle(def.id);
  });

  if (isToggle) {
    label.appendChild(button);
  } else {
    label.insertBefore(button, label.firstChild);
  }
  state.pinButtonsById.set(def.id, button);
}

function updatePinButtons(state) {
  for (const [id, button] of state.pinButtonsById) {
    const pressed = state.selectedIds.includes(id);
    const label = state.definitions.find((def) => def.id === id)?.label || "setting";
    button.setAttribute("aria-pressed", String(pressed));
    button.setAttribute("aria-label", pressed ? `Remove ${label} from optimizer quick settings` : `Pin ${label} to optimizer quick settings`);
    button.title = pressed ? "Remove from optimizer quick settings" : "Pin to optimizer quick settings";
  }
}

function renderMirrors(state) {
  if (!state.body || !state.section) return;

  state.body.replaceChildren();
  state.mirrorsById.clear();

  let rendered = 0;
  for (const id of state.selectedIds) {
    const def = state.definitions.find((item) => item.id === id);
    const source = state.sourceControlsById.get(id);
    if (!def || !source) continue;

    state.body.appendChild(createMirrorField(state, def, source));
    rendered += 1;
  }

  state.section.classList.toggle("hidden", rendered === 0);
}

function createMirrorField(state, def, source) {
  const mirror = source.cloneNode(true);
  mirror.id = `optimizer-quick-${def.id}`;
  mirror.removeAttribute("name");
  mirror.dataset.optimizerQuickMirror = def.id;
  syncControl(source, mirror);

  mirror.addEventListener(inputEventName(mirror), () => {
    syncControl(mirror, source);
    source.dispatchEvent(new Event(inputEventName(source), { bubbles: true }));
  });

  state.mirrorsById.set(def.id, mirror);

  if (isCheckbox(source)) {
    const label = state.doc.createElement("label");
    label.className = "toggle";

    const knob = state.doc.createElement("span");
    knob.className = "toggle-knob";

    const text = state.doc.createElement("span");
    text.className = "text-sm text-slate-600 dark:text-slate-400";
    text.textContent = def.label;

    label.append(mirror, knob, text, createUnpinButton(state, def));
    return label;
  }

  const label = state.doc.createElement("label");
  label.className = "text-sm";

  const labelRow = state.doc.createElement("span");
  labelRow.className = "flex items-center justify-between gap-2";

  const text = state.doc.createElement("span");
  text.className = FIELD_LABEL_CLASS;
  text.textContent = def.label;

  labelRow.append(text, createUnpinButton(state, def));
  label.append(labelRow, mirror);
  return label;
}

function createUnpinButton(state, def) {
  const button = state.doc.createElement("button");
  button.type = "button";
  button.className = "quick-setting-pin";
  button.dataset.quickSettingUnpin = def.id;
  button.setAttribute("aria-pressed", "true");
  button.setAttribute("aria-label", `Remove ${def.label} from optimizer quick settings`);
  button.title = "Remove from optimizer quick settings";
  button.innerHTML = pinIconSvg();
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedIds(state, state.selectedIds.filter((id) => id !== def.id), { notify: true });
  });
  return button;
}

function syncMirrorFromSource(state, id) {
  const source = state.sourceControlsById.get(id);
  const mirror = state.mirrorsById.get(id);
  if (!source || !mirror) return;
  syncControl(source, mirror);
}

function syncControl(from, to) {
  if (isCheckbox(from)) {
    to.checked = from.checked;
  } else {
    to.value = from.value;
  }
  to.disabled = from.disabled;
}

function inputEventName(control) {
  if (isCheckbox(control) || control.tagName === "SELECT") return "change";
  return "input";
}

function isCheckbox(control) {
  return control instanceof HTMLInputElement && control.type === "checkbox";
}

function pinIconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2Z"/></svg>`;
}
