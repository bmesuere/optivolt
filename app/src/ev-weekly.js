// Recurring weekly EV charging plans ("Plan 1: 18:00 → 07:00, 80%, on Wed + Sun").
//
// The schedule is a settings field (evWeeklySchedule): each plan is a time window, a target SoC
// and the weekdays it applies on. Rows are rendered dynamically, so instead
// of marking each row input as a settings input, the serialized schedule lives in one hidden
// `data-settings-input` element: editing a row rewrites its value and dispatches a `change`
// event, which the global settings wiring turns into a save + recompute.

// Display order Monday-first; values follow JS Date#getDay (0 = Sunday).
const WEEKDAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];

const DEFAULT_SLOT = { weekdays: [], start: "18:00", end: "07:00", soc_percent: 80, ess_soc_percent: 100 };

// Settings saved before plans could span several days hold a single `weekday`.
const weekdaysOf = (slot) => (Array.isArray(slot.weekdays) ? slot.weekdays : slot.weekday != null ? [Number(slot.weekday)] : []);

export function readWeeklySchedule(hiddenInput) {
  if (!hiddenInput?.value) return [];
  try {
    const parsed = JSON.parse(hiddenInput.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeWeeklySchedule(hiddenInput, schedule, { notify = true } = {}) {
  if (!hiddenInput) return;
  hiddenInput.value = JSON.stringify(schedule);
  if (notify) hiddenInput.dispatchEvent(new Event("change", { bubbles: true }));
}

function rowSummary(slot) {
  const selected = weekdaysOf(slot);
  const days = WEEKDAYS.filter((d) => selected.includes(d.value)).map((d) => d.label).join(", ") || "no days";
  const overnight = slot.end <= slot.start;
  return `${days}: ${slot.start} → ${overnight ? "next day " : ""}${slot.end}, EV up to ${slot.soc_percent}%, `
    + `home battery ${slot.ess_soc_percent ?? 100}% at the start`;
}

function buildRow(slot, index, onChange, onRemove) {
  const li = document.createElement("li");
  li.className = "space-y-1.5 rounded-md border border-slate-200/70 dark:border-white/10 p-2";
  li.dataset.index = String(index);
  li.title = rowSummary(slot);

  const name = document.createElement("span");
  name.className = "text-xs font-medium";
  name.textContent = `Plan ${index + 1}`;

  const selected = weekdaysOf(slot);
  const days = document.createElement("div");
  days.className = "flex flex-wrap gap-x-3";
  days.setAttribute("role", "group");
  days.setAttribute("aria-label", `Plan ${index + 1} days`);
  const dayBoxes = WEEKDAYS.map((d) => {
    const label = document.createElement("label");
    label.className = "inline-flex items-center gap-1 text-xs";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = String(d.value);
    box.checked = selected.includes(d.value);
    label.append(box, d.label);
    days.append(label);
    return box;
  });

  const timeInput = (value, label) => {
    const input = document.createElement("input");
    input.type = "time";
    input.step = "900";
    input.value = value;
    input.className = "form-input !mt-0 w-24 text-xs";
    input.setAttribute("aria-label", label);
    return input;
  };
  const start = timeInput(slot.start, "Start time");
  const end = timeInput(slot.end, "End time");

  const arrow = document.createElement("span");
  arrow.className = "text-xs text-slate-400";
  arrow.textContent = "→";

  const percentInput = (value, label) => {
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = "100";
    input.step = "1";
    input.value = String(value);
    input.className = "form-input !mt-0 w-16 text-xs";
    input.setAttribute("aria-label", label);
    return input;
  };
  const caption = (text) => {
    const span = document.createElement("span");
    span.className = "text-xs text-slate-400";
    span.textContent = text;
    return span;
  };
  const soc = percentInput(slot.soc_percent, "EV charge limit (%)");
  const pct = caption("%");
  const ess = percentInput(slot.ess_soc_percent ?? 100, "Home battery level at the start (%)");

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "ml-auto text-xs font-medium text-red-600 hover:text-red-700 dark:text-red-400";
  remove.textContent = "Remove";
  remove.setAttribute("aria-label", `Remove plan ${index + 1}`);

  const emit = () => {
    const socValue = Number(soc.value);
    const essValue = Number(ess.value);
    const percent = (v) => Number.isFinite(v) && v >= 0 && v <= 100;
    if (!start.value || !end.value || !percent(socValue) || !percent(essValue)) return;
    onChange(index, {
      weekdays: dayBoxes.filter((box) => box.checked).map((box) => Number(box.value)),
      start: start.value,
      end: end.value,
      soc_percent: Math.round(socValue),
      ess_soc_percent: Math.round(essValue),
    });
  };
  for (const input of [...dayBoxes, start, end, soc, ess]) input.addEventListener("change", emit);
  remove.addEventListener("click", () => onRemove(index));

  const top = document.createElement("div");
  top.className = "flex flex-wrap items-center gap-1.5";
  top.append(name, start, arrow, end, remove);
  const levels = document.createElement("div");
  levels.className = "flex flex-wrap items-center gap-1.5";
  levels.append(caption("EV up to"), soc, pct, caption("· home battery"), ess, caption("% at start"));
  li.append(top, levels, days);
  return li;
}

/** Render the schedule rows and store it in the hidden input (without triggering a save). */
export function renderWeeklySchedule(els, schedule) {
  const list = els.evWeeklyList;
  const hidden = els.evWeeklySchedule;
  const slots = Array.isArray(schedule) ? schedule : [];
  writeWeeklySchedule(hidden, slots, { notify: false });
  if (!list) return;

  const update = (next) => {
    writeWeeklySchedule(hidden, next);
    renderWeeklySchedule(els, next);
  };
  list.replaceChildren(...slots.map((slot, i) => buildRow(
    slot,
    i,
    (index, value) => {
      const next = readWeeklySchedule(hidden);
      next[index] = value;
      writeWeeklySchedule(hidden, next);
      list.children[index]?.setAttribute("title", rowSummary(value));
    },
    (index) => update(readWeeklySchedule(hidden).filter((_, j) => j !== index)),
  )));
  if (els.evWeeklyEmpty) els.evWeeklyEmpty.hidden = slots.length > 0;
}

export function wireWeeklySchedule(els) {
  els.evWeeklyAdd?.addEventListener("click", () => {
    const next = [...readWeeklySchedule(els.evWeeklySchedule), { ...DEFAULT_SLOT }];
    writeWeeklySchedule(els.evWeeklySchedule, next);
    renderWeeklySchedule(els, next);
  });
}
