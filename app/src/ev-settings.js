import { fetchHaEntityState } from "./api/api.js";

const SENSOR_IND_BASE = "mt-1 block text-xs";
const SENSOR_IND_NEUTRAL = `${SENSOR_IND_BASE} text-slate-500 dark:text-slate-400`;
const SENSOR_IND_SUCCESS = `${SENSOR_IND_BASE} text-emerald-600 dark:text-emerald-400`;
const SENSOR_IND_ERROR = `${SENSOR_IND_BASE} text-red-600 dark:text-red-400`;

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
      } catch (err) {
        if (id !== seq) return;
        indicator.textContent = `Error: ${err.message}`;
        indicator.className = SENSOR_IND_ERROR;
        delete indicator.dataset.haState;
      }
    });
  }
}
