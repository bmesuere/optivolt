import { fetchHaEntityState } from "./api/api.js";
import { toDatetimeLocal } from "./utils.js";

const SENSOR_IND_BASE = "mt-1 block text-xs";
const SENSOR_IND_NEUTRAL = `${SENSOR_IND_BASE} text-slate-500 dark:text-slate-400`;
const SENSOR_IND_SUCCESS = `${SENSOR_IND_BASE} text-emerald-600 dark:text-emerald-400`;
const SENSOR_IND_ERROR = `${SENSOR_IND_BASE} text-red-600 dark:text-red-400`;

export function initDepartureDatetimeMin(els) {
  const input = els.evDepartureTime;
  if (!input) return;
  // Round down to the last 15-min block
  const blockMs = Math.floor(Date.now() / (15 * 60 * 1000)) * (15 * 60 * 1000);
  input.min = toDatetimeLocal(new Date(blockMs));
}

export async function refreshEvSensorStates(els) {
  const sensors = [
    { input: els.evSocSensor, indicator: els.evSocValue },
    { input: els.evPlugSensor, indicator: els.evPlugValue },
  ];
  await Promise.allSettled(sensors.map(async ({ input, indicator }) => {
    const entityId = input?.value?.trim();
    if (!entityId || !indicator) return;
    try {
      const state = await fetchHaEntityState(entityId);
      indicator.textContent = `Current value: ${state.state}`;
      indicator.className = SENSOR_IND_SUCCESS;
      indicator.dataset.haState = state.state;
    } catch {
      // HA not configured or entity unavailable - leave indicator as-is
    }
  }));
  updateEvSocQuickSet(els);
}

export function updateEvDepartureQuickSet(els, rows) {
  const btn = els.evDepartureQuickSet;
  if (!btn) return;
  const lastRow = rows[rows.length - 1];
  if (!lastRow) {
    btn.disabled = true;
    btn.title = "Run a plan first";
    btn.onclick = null;
    return;
  }
  const d = new Date(lastRow.timestampMs);
  const dtLocal = toDatetimeLocal(d);
  btn.disabled = false;
  btn.title = `Set to end of current plan (${d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })})`;
  btn.onclick = () => {
    els.evDepartureTime.value = dtLocal;
    els.evDepartureTime.dispatchEvent(new Event('input', { bubbles: true }));
  };
}

function updateEvSocQuickSet(els) {
  const btn = els.evTargetSocQuickSet;
  if (!btn) return;
  const soc = parseFloat(els.evSocValue?.dataset.haState);
  if (!isNaN(soc)) {
    const rounded = Math.round(soc);
    btn.disabled = false;
    btn.title = `Set to current EV SoC (${rounded}%)`;
    btn.onclick = () => {
      els.evTargetSoc.value = rounded;
      els.evTargetSoc.dispatchEvent(new Event('input', { bubbles: true }));
    };
  } else {
    btn.disabled = true;
    btn.title = "Configure EV SoC sensor first";
    btn.onclick = null;
  }
}

export function wireEvSensorInputs(els, { persistConfig, persistConfigDebounced, debounceRun }) {
  const sensors = [
    { input: els.evSocSensor, indicator: els.evSocValue },
    { input: els.evPlugSensor, indicator: els.evPlugValue },
  ];

  for (const { input, indicator } of sensors) {
    if (!input || !indicator) continue;

    let seq = 0;

    input.addEventListener("input", () => {
      indicator.textContent = "";
      indicator.className = SENSOR_IND_NEUTRAL;
      delete indicator.dataset.haState;
      updateEvSocQuickSet(els);
    });

    input.addEventListener("blur", async () => {
      const entityId = input.value.trim();
      if (!entityId) {
        indicator.textContent = "";
        return;
      }

      const id = ++seq;

      // Flush immediately so the server has the latest HA credentials before
      // we validate the entity.
      persistConfigDebounced.cancel();
      debounceRun.cancel();
      await persistConfig();

      if (id !== seq) return;

      try {
        const state = await fetchHaEntityState(entityId);
        if (id !== seq) return;
        indicator.textContent = `Current value: ${state.state}`;
        indicator.className = SENSOR_IND_SUCCESS;
        indicator.dataset.haState = state.state;
        updateEvSocQuickSet(els);
      } catch (err) {
        if (id !== seq) return;
        indicator.textContent = `Error: ${err.message}`;
        indicator.className = SENSOR_IND_ERROR;
        delete indicator.dataset.haState;
        updateEvSocQuickSet(els);
      }
    });
  }
}
