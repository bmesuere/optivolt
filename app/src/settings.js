/**
 * settings.js
 *
 * Manages the Settings tab: system settings inputs, VRM fetch,
 * Home Assistant connection, and sensor configuration.
 */

import { savePredictionConfig } from './api/api.js';
import { debounce, setVal, getVal, parseSilently } from './utils.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Boot the Settings tab: wire inputs and hydrate HA/sensor fields.
 *
 * @param {object} opts
 * @param {() => void} opts.onSystemSave  — called when a system-settings input changes (save-only, no recompute)
 * @param {() => void} opts.onVrmRefresh  — called when the "Fetch settings" button is clicked
 */
export function initSettingsTab({ onSystemSave, onVrmRefresh }) {
  wireSystemInputs(onSystemSave);
  wirePredictionInputs();

  const vrmBtn = document.getElementById('vrm-fetch-settings');
  if (vrmBtn) vrmBtn.addEventListener('click', onVrmRefresh);

  // Settings-tab fields (HA, sensors) are hydrated when predictions.js
  // fetches the prediction config and calls hydratePredictionSettings().
}

/**
 * Hydrate Settings-tab fields that come from the prediction config:
 * HA section visibility + URL/token, sensor textareas, and the sensor dropdown.
 *
 * Also called by predictions.js when it fetches the prediction config,
 * so both tabs stay in sync without a redundant API call.
 */
export function hydratePredictionSettings(config) {
  // HA section
  const haSection = document.getElementById('settings-ha');
  if (haSection) {
    haSection.classList.toggle('hidden', !!config.isAddon);
    if (!config.isAddon) {
      setVal('pred-ha-url', config.haUrl ?? '');
      setVal('pred-ha-token', config.haToken ?? '');
    }
  }

  // Sensor / derived textareas
  setVal('pred-sensors', config.sensors ? JSON.stringify(config.sensors, null, 2) : '');
  setVal('pred-derived', config.derived ? JSON.stringify(config.derived, null, 2) : '');

  // Sensor dropdown (used by Predictions tab controls)
  const select = document.getElementById('pred-active-sensor');
  if (select) {
    select.innerHTML = '<option value="" disabled selected>Select a sensor\u2026</option>';

    const addOption = (s) => {
      const opt = document.createElement('option');
      opt.textContent = s.name || s.id;
      opt.value = opt.textContent;
      select.appendChild(opt);
    };

    if (config.sensors) config.sensors.forEach(addOption);
    if (config.derived) config.derived.forEach(addOption);
  }
}

/**
 * Read the prediction-settings form values (HA + sensors) from the DOM.
 * Used by predictions.js when building the payload for /predictions/config.
 */
export function readPredictionSettingsValues() {
  const sensors = parseSilently(getVal('pred-sensors'));
  const derived = parseSilently(getVal('pred-derived'));

  return {
    haUrl: getVal('pred-ha-url'),
    haToken: getVal('pred-ha-token'),
    ...(sensors !== null ? { sensors } : {}),
    ...(derived !== null ? { derived } : {}),
  };
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/** Wire system-settings inputs (data-settings-only) to save-only callback. */
function wireSystemInputs(onSave) {
  for (const el of document.querySelectorAll('[data-settings-only="true"]')) {
    el.addEventListener('input', onSave);
    el.addEventListener('change', onSave);
  }
}

/** Wire prediction-settings inputs on the Settings tab to debounced save. */
function wirePredictionInputs() {
  const debouncedSave = debounce(async () => {
    try {
      const values = readPredictionSettingsValues();
      await savePredictionConfig(values);
    } catch (err) {
      console.error('Failed to save prediction settings:', err);
    }
  }, 600);

  // Only wire the prediction-settings inputs that live on the Settings tab
  // (HA URL, token, sensors, derived). The Predictions-tab controls are
  // wired separately in predictions.js.
  for (const id of ['pred-ha-url', 'pred-ha-token', 'pred-sensors', 'pred-derived']) {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', debouncedSave);
      el.addEventListener('change', debouncedSave);
    }
  }
}

