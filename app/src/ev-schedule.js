import { toDatetimeLocal, escapeHtml } from "./utils.js";
import {
  fetchEvScheduleEntries,
  createEvScheduleEntry,
  updateEvScheduleEntry,
  deleteEvScheduleEntry,
  fetchEvTripPresets,
  saveEvTripPreset,
  deleteEvTripPreset,
} from "./api/api.js";

const TYPE_BADGE = {
  trip:      "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-400",
  arrival:   "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-400",
  departure: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
  target:    "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400",
};
const SOC_LABEL = {
  trip:      "Estimated trip usage (%)",
  arrival:   "Assumed SoC on arrival (%)",
  departure: "Target SoC at departure (%)",
  target:    "Required SoC (%)",
};
const TYPE_ACTIVE = ["bg-white", "text-sky-700", "shadow-sm", "dark:bg-slate-900", "dark:text-sky-400"];
const TYPE_INACTIVE = ["text-slate-500", "dark:text-slate-400"];

const DEFAULT_TRIP_BUFFER_PERCENT = 20;

const DEFAULT_STEP_M = 15;
const fmtEntryTime = new Intl.DateTimeFormat([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const fmtEntryTimeShort = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * Controller for the EV schedule entry list + inline editor (trip / arrival / departure /
 * target), mirroring the manual prediction-adjustment editor. Entries are server-owned (CRUD
 * via /ev), sorted by time, and may be entered outside the current horizon. A trip is a
 * departure + arrival pair with an optional usage estimate; the required SoC at departure
 * (usage + the global trip buffer) is derived, not stored. `onChange` fires after any mutation
 * so the caller can trigger a re-solve.
 */
export function createEvScheduleController({ els, getPlanRows = () => [], onChange = () => {} }) {
  let entries = [];
  // Named trip usage estimates ("Knokke" → 35%), server-owned like the entries themselves.
  let tripPresets = [];
  let namingPreset = false; // the preset row is showing its "save this value as…" name input
  let draft = null; // { id?, type, } — current editor state
  let horizonMs = null;
  // A trip almost always returns on the day it starts, so the arrival field mirrors the departure
  // until the user edits it themselves — the date is then already right and only the time is left.
  let arrivalFollowsDeparture = false;

  const getEntries = () => entries;

  // The planning slot length, straight from the Step setting (which accepts 30 and 60 too).
  const slotMs = () => {
    const n = Number(els.step?.value);
    return (Number.isFinite(n) && n > 0 ? n : DEFAULT_STEP_M) * 60 * 1000;
  };
  const blockNowMs = () => Math.floor(Date.now() / slotMs()) * slotMs();
  // The pickers step in slot-sized blocks, but a hand-typed minute can still land off-grid, so
  // snap to a boundary on save and store the time the solver actually plans the entry at.
  // buildEvConfig floors an event into its slot, so this floors too: rounding 08:08 up to 08:15
  // under a 15-minute step would hand the optimizer a charging slot the car is not there for.
  const fromDatetimeLocal = (value) => {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? new Date(Math.floor(ms / slotMs()) * slotMs()).toISOString() : null;
  };
  // Given a departure and arrival already floored by fromDatetimeLocal, the block the arrival is
  // stored in: their own block, unless that is the departure's — a trip shorter than one slot is
  // stretched to a single slot rather than collapsed to a zero-length one.
  const snappedTripEndMs = (departureIso, arrivalIso) =>
    Math.max(new Date(arrivalIso).getTime(), new Date(departureIso).getTime() + slotMs());

  // Rewrite a time field to the block its value will be stored in, so the editor shows the grid
  // the solver plans on while editing instead of only after saving. Runs on blur rather than on
  // every keystroke: assigning `value` mid-edit would throw the caret back to the first segment.
  function snapDepartureInput() {
    const iso = fromDatetimeLocal(els.evEntryTime?.value ?? "");
    if (!iso) return;
    els.evEntryTime.value = toDatetimeLocal(new Date(iso));
  }

  function snapArrivalInput() {
    const arrivalIso = fromDatetimeLocal(els.evEntryEndTime?.value ?? "");
    if (!arrivalIso) return;
    const departureIso = fromDatetimeLocal(els.evEntryTime?.value ?? "");
    // Only stretch an arrival the user typed after the departure; one typed before it is left
    // where it is, so saving still reports the ordering rather than silently moving it forward.
    const typedInOrder = new Date(els.evEntryEndTime.value).getTime() > new Date(els.evEntryTime?.value ?? "").getTime();
    const ms = departureIso && typedInOrder
      ? snappedTripEndMs(departureIso, arrivalIso)
      : new Date(arrivalIso).getTime();
    els.evEntryEndTime.value = toDatetimeLocal(new Date(ms));
  }

  const tripBufferPercent = () => {
    const n = Number(els.evTripSocBuffer?.value);
    return Number.isFinite(n) ? n : DEFAULT_TRIP_BUFFER_PERCENT;
  };
  const derivedTripTarget = (usage_percent) =>
    Math.min(100, Math.round(usage_percent + tripBufferPercent()));

  function setEntries(next) {
    entries = Array.isArray(next) ? next : [];
    renderList();
    onChange(entries);
  }

  // Read the server's (pruned) entry list. Called on boot and after every solve, so a failed
  // fetch keeps the entries already held rather than blanking the list and its annotations.
  async function loadEntries() {
    try {
      const result = await fetchEvScheduleEntries();
      if (Array.isArray(result?.entries)) entries = result.entries;
    } catch (error) {
      // Keep the entries we have — but say so, or a refresh that silently fails looks like
      // the server simply having nothing to prune.
      console.error("Failed to load EV schedule entries", error);
    }
    renderList();
  }

  function sortedEntries() {
    return [...entries].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  }

  // "Jun 17 12:45 → 18:00" (same-day arrival shows time only).
  function fmtTripSpan(entry) {
    const dep = new Date(entry.time);
    const arr = new Date(entry.endTime);
    const sameDay = dep.toDateString() === arr.toDateString();
    return `${fmtEntryTime.format(dep)} → ${(sameDay ? fmtEntryTimeShort : fmtEntryTime).format(arr)}`;
  }

  function renderList() {
    const list = els.evScheduleEntriesList;
    if (!list) return;
    const sorted = sortedEntries();
    if (els.evScheduleEntriesCount) {
      els.evScheduleEntriesCount.textContent = sorted.length
        ? `· ${sorted.length} ${sorted.length === 1 ? "entry" : "entries"}`
        : "";
    }
    if (!sorted.length) {
      list.innerHTML = `<li class="py-1.5 text-xs text-slate-400 dark:text-slate-500">No schedule entries.</li>`;
      return;
    }
    const nowMs = Date.now();
    list.innerHTML = sorted.map((e) => {
      const isTrip = e.type === "trip";
      const label = isTrip
        ? escapeHtml(fmtTripSpan(e))
        : escapeHtml(fmtEntryTime.format(new Date(e.time)));
      let extras = "";
      if (isTrip && Number.isFinite(e.usage_percent)) {
        extras += `<span class="ml-2 font-mono text-xs text-slate-400 dark:text-slate-500" title="Estimated trip usage">−${e.usage_percent}%</span>`;
        extras += `<span class="ml-1.5 font-mono text-xs text-emerald-600 dark:text-emerald-400" title="Required SoC at departure (usage + ${tripBufferPercent()}% buffer)">≥${derivedTripTarget(e.usage_percent)}%</span>`;
      } else if (Number.isFinite(e.soc_percent)) {
        extras += `<span class="ml-2 font-mono text-xs text-slate-400 dark:text-slate-500">${e.soc_percent}%</span>`;
      }
      // A departure/trip whose departure time passed but that the server still keeps means the
      // car is still plugged in: it keeps charging toward its target until it actually leaves.
      if ((isTrip || e.type === "departure") && new Date(e.time).getTime() < nowMs) {
        extras += `<span class="ml-1.5 inline-block rounded px-1 py-0.5 text-[9px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400" title="Departure time has passed but the car is still connected">overdue</span>`;
      }
      return `<li data-entry-id="${escapeHtml(e.id)}" class="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 dark:border-white/10 dark:bg-slate-800/50">
        <button type="button" data-edit class="flex flex-1 items-center gap-2 text-left">
          <span class="inline-block w-20 shrink-0 rounded px-1.5 py-0.5 text-center text-[10px] font-medium capitalize ${TYPE_BADGE[e.type] ?? ""}">${escapeHtml(e.type)}</span>
          <span class="font-mono text-xs text-slate-600 dark:text-slate-300">${label}</span>
          ${extras}
        </button>
        <button type="button" data-remove title="Remove" aria-label="Remove entry" class="shrink-0 text-slate-300 hover:text-red-500 dark:text-slate-600 dark:hover:text-red-400">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </li>`;
    }).join("");
  }

  // --------------------------- Trip usage presets ---------------------------
  // A trip's usage estimate depends on the destination, not just its distance, so the presets
  // are named ones the user builds up ("Brussels commute", "Knokke") rather than anything
  // derived. They live in the trip editor: a chip fills the field in, and saving the field's
  // current value under a name is how one is created or corrected.

  async function loadTripPresets() {
    try {
      const result = await fetchEvTripPresets();
      if (Array.isArray(result?.presets)) tripPresets = result.presets;
    } catch (error) {
      // Keep whatever we have; the field still works without its shortcuts.
      console.error("Failed to load EV trip presets", error);
    }
    renderTripPresets();
  }

  function renderTripPresets() {
    const row = els.evEntryPresets;
    if (!row) return;
    const isTrip = draft?.type === "trip";
    row.classList.toggle("hidden", !isTrip);
    row.classList.toggle("flex", isTrip);
    if (!isTrip) return;

    if (namingPreset) {
      row.innerHTML = `
        <input data-preset-name type="text" maxlength="40" placeholder="Name this trip…"
          class="form-input !mt-0 h-7 flex-1 min-w-0 text-xs" />
        <button type="button" data-preset-confirm class="rounded-md bg-sky-600 px-2 py-1 text-xs font-medium text-white hover:bg-sky-700">Save</button>
        <button type="button" data-preset-cancel class="rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700">Cancel</button>`;
      row.querySelector("[data-preset-name]")?.focus();
      return;
    }

    const chips = [...tripPresets]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => `
        <span class="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white pl-2 pr-1 py-0.5 dark:border-white/10 dark:bg-slate-800/60">
          <button type="button" data-preset-apply="${escapeHtml(p.id)}" class="text-xs text-slate-600 hover:text-sky-600 dark:text-slate-300 dark:hover:text-sky-400">
            ${escapeHtml(p.name)} <span class="font-mono text-slate-400 dark:text-slate-500">${p.usage_percent}%</span>
          </button>
          <button type="button" data-preset-remove="${escapeHtml(p.id)}" title="Remove preset" aria-label="Remove preset ${escapeHtml(p.name)}"
            class="text-slate-300 hover:text-red-500 dark:text-slate-600 dark:hover:text-red-400">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
          </button>
        </span>`)
      .join("");

    row.innerHTML = `${chips}
      <button type="button" data-preset-add class="rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-xs text-slate-500 hover:border-sky-400 hover:text-sky-600 dark:border-white/15 dark:text-slate-400 dark:hover:text-sky-400">
        + Save as…
      </button>`;
  }

  /** The usage estimate currently typed in, or null when it is empty or out of range. */
  function currentUsagePercent() {
    const raw = els.evEntrySoc?.value ?? "";
    if (raw === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : null;
  }

  function applyTripPreset(id) {
    const preset = tripPresets.find((p) => p.id === id);
    if (!preset || !els.evEntrySoc) return;
    els.evEntrySoc.value = String(preset.usage_percent);
    clearError();
    updateTripHint();
  }

  async function confirmTripPreset(name) {
    const usage_percent = currentUsagePercent();
    if (usage_percent == null) { showError("Fill in a usage estimate before saving it as a preset."); return; }
    if (!name.trim()) { showError("Give the preset a name."); return; }
    try {
      const result = await saveEvTripPreset({ name: name.trim(), usage_percent });
      if (Array.isArray(result?.presets)) tripPresets = result.presets;
      namingPreset = false;
      clearError();
      renderTripPresets();
    } catch (err) {
      showError(err?.message || "Could not save the preset.");
    }
  }

  async function removeTripPreset(id) {
    try {
      const result = await deleteEvTripPreset(id);
      if (Array.isArray(result?.presets)) tripPresets = result.presets;
    } catch (err) {
      showError(err?.message || "Could not remove the preset.");
    }
    renderTripPresets();
  }

  function wireTripPresets() {
    els.evEntryPresets?.addEventListener("click", (event) => {
      const apply = event.target.closest("[data-preset-apply]");
      if (apply) { applyTripPreset(apply.dataset.presetApply); return; }
      const remove = event.target.closest("[data-preset-remove]");
      if (remove) { void removeTripPreset(remove.dataset.presetRemove); return; }
      if (event.target.closest("[data-preset-add]")) {
        // Saving a preset saves the value in the field, so refuse early rather than after naming.
        if (currentUsagePercent() == null) { showError("Fill in a usage estimate before saving it as a preset."); return; }
        namingPreset = true;
        clearError();
        renderTripPresets();
        return;
      }
      if (event.target.closest("[data-preset-confirm]")) {
        void confirmTripPreset(els.evEntryPresets.querySelector("[data-preset-name]")?.value ?? "");
        return;
      }
      if (event.target.closest("[data-preset-cancel]")) {
        namingPreset = false;
        renderTripPresets();
      }
    });

    // Enter confirms the name, Escape backs out without closing the whole entry editor.
    els.evEntryPresets?.addEventListener("keydown", (event) => {
      if (!event.target.closest("[data-preset-name]")) return;
      if (event.key === "Enter") { event.preventDefault(); void confirmTripPreset(event.target.value); }
      if (event.key === "Escape") { event.stopPropagation(); namingPreset = false; renderTripPresets(); }
    });
  }

  function updateTripHint() {
    const hint = els.evEntryTripHint;
    if (!hint) return;
    const usage = Number(els.evEntrySoc?.value);
    const show = draft?.type === "trip" && els.evEntrySoc?.value !== "" && Number.isFinite(usage) && usage >= 0 && usage <= 100;
    hint.classList.toggle("hidden", !show);
    if (show) {
      hint.textContent = `Requires ≥ ${derivedTripTarget(usage)}% at departure (usage + ${tripBufferPercent()}% buffer).`;
    }
  }

  function refreshTypeSegments() {
    document.querySelectorAll(".ev-entry-type").forEach((btn) => {
      const active = btn.dataset.entryType === draft?.type;
      btn.classList.toggle("ev-entry-type-active", active);
      btn.classList.remove(...TYPE_ACTIVE, ...TYPE_INACTIVE);
      btn.classList.add(...(active ? TYPE_ACTIVE : TYPE_INACTIVE));
    });
    const isTrip = draft?.type === "trip";
    if (els.evEntryTimeLabel) els.evEntryTimeLabel.textContent = isTrip ? "Departure" : "Time";
    if (els.evEntryEndRow) els.evEntryEndRow.classList.toggle("hidden", !isTrip);
    if (els.evEntrySocLabel) els.evEntrySocLabel.textContent = SOC_LABEL[draft?.type] ?? "SoC (%)";
    if (els.evEntrySoc) els.evEntrySoc.placeholder = draft?.type === "target" ? "required" : (isTrip ? "optional" : "none");
    renderTripPresets();
    updateTripHint();
  }

  function setType(type) {
    if (!draft) return;
    draft.type = type;
    refreshTypeSegments();
  }

  function clearError() {
    if (els.evEntryError) { els.evEntryError.textContent = ""; els.evEntryError.classList.add("hidden"); }
  }
  function showError(msg) {
    if (els.evEntryError) { els.evEntryError.textContent = msg; els.evEntryError.classList.remove("hidden"); }
  }

  function mirrorDepartureIntoArrival() {
    if (!els.evEntryTime || !els.evEntryEndTime) return;
    if (!arrivalFollowsDeparture && els.evEntryEndTime.value !== "") return;
    els.evEntryEndTime.value = els.evEntryTime.value;
    arrivalFollowsDeparture = els.evEntryTime.value !== "";
  }

  function openEditor(entry) {
    draft = entry
      ? { id: entry.id, type: entry.type }
      : { type: "trip" };
    if (els.evEntryTime) els.evEntryTime.value = entry?.time ? toDatetimeLocal(new Date(entry.time)) : "";
    if (els.evEntryEndTime) els.evEntryEndTime.value = entry?.endTime ? toDatetimeLocal(new Date(entry.endTime)) : "";
    arrivalFollowsDeparture = false;
    if (els.evEntrySoc) {
      const value = entry?.type === "trip" ? entry?.usage_percent : entry?.soc_percent;
      els.evEntrySoc.value = Number.isFinite(value) ? String(value) : "";
    }
    namingPreset = false;
    if (els.evEntryDelete) els.evEntryDelete.classList.toggle("hidden", !entry);
    for (const input of [els.evEntryTime, els.evEntryEndTime]) {
      if (input) input.step = String(slotMs() / 1000);
    }
    clearError();
    refreshTypeSegments();
    if (els.evEntryEditor) els.evEntryEditor.classList.remove("hidden");
  }

  function hideEditor() {
    draft = null;
    if (els.evEntryEditor) els.evEntryEditor.classList.add("hidden");
  }

  function readPayload() {
    if (!draft) return null;
    const type = draft.type;
    const time = fromDatetimeLocal(els.evEntryTime?.value ?? "");
    if (!time) { showError(type === "trip" ? "Pick a valid departure date and time." : "Pick a valid date and time."); return null; }
    const socRaw = els.evEntrySoc?.value ?? "";
    const hasSoc = socRaw !== "";
    let soc_percent;
    if (hasSoc) {
      soc_percent = Number(socRaw);
      if (!Number.isFinite(soc_percent) || soc_percent < 0 || soc_percent > 100) {
        showError(type === "trip" ? "Usage must be between 0 and 100." : "SoC must be between 0 and 100."); return null;
      }
    } else if (type === "target") {
      showError("A target needs a required SoC."); return null;
    }
    if (type === "trip") {
      const endTime = fromDatetimeLocal(els.evEntryEndTime?.value ?? "");
      if (!endTime) { showError("Pick a valid arrival date and time."); return null; }
      // Order is judged on the field values, not on the floored times: a trip shorter than a
      // slot (08:08 → 08:14) is a real trip and must stay savable. Leaving either field snaps it
      // (08:00 → 08:15), so this usually compares already-snapped values; it still has to hold
      // for a value that reaches save unblurred. buildEvConfig stretches a sub-slot trip to a
      // single slot, so store exactly that rather than a zero-length one.
      if (new Date(els.evEntryEndTime.value).getTime() <= new Date(els.evEntryTime.value).getTime()) {
        showError("Arrival must be after departure."); return null;
      }
      const endMs = snappedTripEndMs(time, endTime);
      // Always send usage_percent (null when cleared) so an edit can remove a previously-set value.
      return { type, time, endTime: new Date(endMs).toISOString(), usage_percent: soc_percent ?? null };
    }
    // Always send soc_percent (null when cleared) so an edit can remove a previously-set value.
    return { type, time, soc_percent: soc_percent ?? null };
  }

  async function saveEntry() {
    const payload = readPayload();
    if (!payload) return;
    try {
      const result = draft.id
        ? await updateEvScheduleEntry(draft.id, payload)
        : await createEvScheduleEntry(payload);
      setEntries(result.entries);
      hideEditor();
    } catch (err) {
      showError(err?.message || "Could not save entry.");
    }
  }

  async function deleteEntry(id) {
    try {
      const result = await deleteEvScheduleEntry(id);
      setEntries(result.entries);
      if (draft?.id === id) hideEditor();
    } catch { /* leave the list as-is on failure */ }
  }

  // Enable/disable the "horizon end" quick-sets from the latest plan's last row.
  function refreshHorizonQuickSet(rows = getPlanRows()) {
    const last = rows?.[rows.length - 1];
    horizonMs = last?.timestampMs ?? null;
    for (const btn of [els.evEntryTimeHorizon, els.evEntryEndHorizon]) {
      if (!btn) continue;
      btn.disabled = horizonMs == null;
      btn.title = horizonMs == null ? "Run a plan first" : "Set to end of current plan";
    }
  }

  function wireEditor() {
    wireTripPresets();
    void loadTripPresets();
    els.evEntryAdd?.addEventListener("click", () => openEditor(null));
    els.evEntryCancel?.addEventListener("click", hideEditor);
    els.evEntrySave?.addEventListener("click", saveEntry);
    els.evEntryDelete?.addEventListener("click", () => { if (draft?.id) deleteEntry(draft.id); });

    document.querySelectorAll(".ev-entry-type").forEach((btn) => {
      btn.addEventListener("click", () => setType(btn.dataset.entryType));
    });

    els.evEntryTime?.addEventListener("input", mirrorDepartureIntoArrival);
    els.evEntryTime?.addEventListener("blur", () => {
      snapDepartureInput();
      mirrorDepartureIntoArrival(); // an arrival still following the departure follows the snap too
    });
    els.evEntryEndTime?.addEventListener("blur", snapArrivalInput);
    els.evEntryTimeClear?.addEventListener("click", () => {
      if (els.evEntryTime) els.evEntryTime.value = "";
      mirrorDepartureIntoArrival();
    });
    els.evEntryTimeNow?.addEventListener("click", () => {
      if (els.evEntryTime) els.evEntryTime.value = toDatetimeLocal(new Date(blockNowMs()));
      mirrorDepartureIntoArrival();
    });
    els.evEntryTimeHorizon?.addEventListener("click", () => {
      if (horizonMs != null && els.evEntryTime) els.evEntryTime.value = toDatetimeLocal(new Date(horizonMs));
      mirrorDepartureIntoArrival();
    });
    els.evEntryEndTime?.addEventListener("input", () => { arrivalFollowsDeparture = false; });
    els.evEntryEndClear?.addEventListener("click", () => {
      if (els.evEntryEndTime) els.evEntryEndTime.value = "";
      arrivalFollowsDeparture = false;
    });
    els.evEntryEndHorizon?.addEventListener("click", () => {
      if (horizonMs != null && els.evEntryEndTime) els.evEntryEndTime.value = toDatetimeLocal(new Date(horizonMs));
      arrivalFollowsDeparture = false;
    });
    els.evEntrySoc?.addEventListener("input", updateTripHint);
    // The derived "≥ x%" targets in the list and the editor hint both depend on the global trip
    // buffer setting, so a buffer change must refresh them too (persistence is wired elsewhere).
    els.evTripSocBuffer?.addEventListener("input", () => { renderList(); updateTripHint(); });

    els.evScheduleEntriesList?.addEventListener("click", (event) => {
      const li = event.target.closest("[data-entry-id]");
      if (!li) return;
      const id = li.dataset.entryId;
      if (event.target.closest("[data-remove]")) { deleteEntry(id); return; }
      if (event.target.closest("[data-edit]")) {
        const entry = entries.find((e) => e.id === id);
        if (entry) openEditor(entry);
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && els.evEntryEditor && !els.evEntryEditor.classList.contains("hidden")) {
        hideEditor();
      }
    });
  }

  return {
    loadEntries, getEntries, setEntries, renderList, openEditor, hideEditor, wireEditor,
    refreshHorizonQuickSet, loadTripPresets,
  };
}
