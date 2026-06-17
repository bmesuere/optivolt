import { toDatetimeLocal, escapeHtml } from "./utils.js";
import {
  fetchEvScheduleEntries,
  createEvScheduleEntry,
  updateEvScheduleEntry,
  deleteEvScheduleEntry,
} from "./api/api.js";

const TYPE_BADGE = {
  arrival:   "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-400",
  departure: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
  target:    "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400",
};
const SOC_LABEL = {
  arrival:   "Assumed SoC on arrival (%)",
  departure: "Target SoC at departure (%)",
  target:    "Required SoC (%)",
};
const TYPE_ACTIVE = ["bg-white", "text-sky-700", "shadow-sm", "dark:bg-slate-900", "dark:text-sky-400"];
const TYPE_INACTIVE = ["text-slate-500", "dark:text-slate-400"];

const blockNowMs = () => Math.floor(Date.now() / (15 * 60 * 1000)) * (15 * 60 * 1000);
const fromDatetimeLocal = (value) => {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const fmtEntryTime = new Intl.DateTimeFormat([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * Controller for the EV schedule entry list + inline editor (arrival / departure / target),
 * mirroring the manual prediction-adjustment editor. Entries are server-owned (CRUD via /ev),
 * sorted by time, and may be entered outside the current horizon. `onChange` fires after any
 * mutation so the caller can trigger a re-solve.
 */
export function createEvScheduleController({ els, getPlanRows = () => [], onChange = () => {} }) {
  let entries = [];
  let draft = null; // { id?, type, } — current editor state
  let horizonMs = null;

  const getEntries = () => entries;

  function setEntries(next) {
    entries = Array.isArray(next) ? next : [];
    renderList();
    onChange(entries);
  }

  async function loadEntries() {
    try {
      const result = await fetchEvScheduleEntries();
      entries = Array.isArray(result?.entries) ? result.entries : [];
    } catch {
      entries = [];
    }
    renderList();
  }

  function sortedEntries() {
    return [...entries].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
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
    list.innerHTML = sorted.map((e) => {
      const soc = Number.isFinite(e.soc_percent) ? `<span class="ml-2 font-mono text-xs text-slate-400 dark:text-slate-500">${e.soc_percent}%</span>` : "";
      const label = escapeHtml(fmtEntryTime.format(new Date(e.time)));
      return `<li data-entry-id="${escapeHtml(e.id)}" class="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 dark:border-white/10 dark:bg-slate-800/50">
        <button type="button" data-edit class="flex flex-1 items-center gap-2 text-left">
          <span class="inline-block w-20 shrink-0 rounded px-1.5 py-0.5 text-center text-[10px] font-medium capitalize ${TYPE_BADGE[e.type] ?? ""}">${escapeHtml(e.type)}</span>
          <span class="font-mono text-xs text-slate-600 dark:text-slate-300">${label}</span>
          ${soc}
        </button>
        <button type="button" data-remove title="Remove" aria-label="Remove entry" class="shrink-0 text-slate-300 hover:text-red-500 dark:text-slate-600 dark:hover:text-red-400">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </li>`;
    }).join("");
  }

  function refreshTypeSegments() {
    document.querySelectorAll(".ev-entry-type").forEach((btn) => {
      const active = btn.dataset.entryType === draft?.type;
      btn.classList.toggle("ev-entry-type-active", active);
      btn.classList.remove(...TYPE_ACTIVE, ...TYPE_INACTIVE);
      btn.classList.add(...(active ? TYPE_ACTIVE : TYPE_INACTIVE));
    });
    if (els.evEntrySocLabel) els.evEntrySocLabel.textContent = SOC_LABEL[draft?.type] ?? "SoC (%)";
    if (els.evEntrySoc) els.evEntrySoc.placeholder = draft?.type === "target" ? "required" : "none";
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

  function openEditor(entry) {
    draft = entry
      ? { id: entry.id, type: entry.type }
      : { type: "departure" };
    if (els.evEntryTime) els.evEntryTime.value = entry?.time ? toDatetimeLocal(new Date(entry.time)) : "";
    if (els.evEntrySoc) els.evEntrySoc.value = Number.isFinite(entry?.soc_percent) ? String(entry.soc_percent) : "";
    if (els.evEntryDelete) els.evEntryDelete.classList.toggle("hidden", !entry);
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
    if (!time) { showError("Pick a valid date and time."); return null; }
    const socRaw = els.evEntrySoc?.value ?? "";
    const hasSoc = socRaw !== "";
    let soc_percent;
    if (hasSoc) {
      soc_percent = Number(socRaw);
      if (!Number.isFinite(soc_percent) || soc_percent < 0 || soc_percent > 100) {
        showError("SoC must be between 0 and 100."); return null;
      }
    } else if (type === "target") {
      showError("A target needs a required SoC."); return null;
    }
    return { type, time, ...(soc_percent != null ? { soc_percent } : {}) };
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

  // Enable/disable the "horizon end" quick-set from the latest plan's last row.
  function refreshHorizonQuickSet(rows = getPlanRows()) {
    const btn = els.evEntryTimeHorizon;
    const last = rows?.[rows.length - 1];
    horizonMs = last?.timestampMs ?? null;
    if (!btn) return;
    btn.disabled = horizonMs == null;
    btn.title = horizonMs == null ? "Run a plan first" : "Set to end of current plan";
  }

  function wireEditor() {
    els.evEntryAdd?.addEventListener("click", () => openEditor(null));
    els.evEntryCancel?.addEventListener("click", hideEditor);
    els.evEntrySave?.addEventListener("click", saveEntry);
    els.evEntryDelete?.addEventListener("click", () => { if (draft?.id) deleteEntry(draft.id); });

    document.querySelectorAll(".ev-entry-type").forEach((btn) => {
      btn.addEventListener("click", () => setType(btn.dataset.entryType));
    });

    els.evEntryTimeClear?.addEventListener("click", () => { if (els.evEntryTime) els.evEntryTime.value = ""; });
    els.evEntryTimeNow?.addEventListener("click", () => {
      if (els.evEntryTime) els.evEntryTime.value = toDatetimeLocal(new Date(blockNowMs()));
    });
    els.evEntryTimeHorizon?.addEventListener("click", () => {
      if (horizonMs != null && els.evEntryTime) els.evEntryTime.value = toDatetimeLocal(new Date(horizonMs));
    });

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

  return { loadEntries, getEntries, setEntries, renderList, openEditor, hideEditor, wireEditor, refreshHorizonQuickSet };
}
