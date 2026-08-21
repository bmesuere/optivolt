import { fetchPredictionConfig, savePredictionConfig, fetchHaEntityState } from '../api/api.js';
import { debounce } from '../utils.js';
import { initValidation } from '../predictions-validation.js';

// Predictor list state; the forecast is the per-slot sum of these.
let predictors = [];
let sensorOptions = [];
// Sensor config state: HA sensors ({ id, name, unit }) and derived sensors
// ({ name, formula: ['+Ref', '-Ref', …] }).
let sensorsState = [];
let derivedState = [];

const debouncedSave = debounce(savePredictionFormSilently, 600);

const REMOVE_BTN_CLASS = 'shrink-0 rounded p-1.5 text-slate-400 hover:text-red-500 dark:hover:text-red-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

const ENTITY_IND_BASE = 'mt-1 block text-xs';
const ENTITY_IND_NEUTRAL = `${ENTITY_IND_BASE} text-slate-500 dark:text-slate-400`;
const ENTITY_IND_SUCCESS = `${ENTITY_IND_BASE} text-emerald-600 dark:text-emerald-400`;
const ENTITY_IND_ERROR = `${ENTITY_IND_BASE} text-red-600 dark:text-red-400`;

export async function hydratePredictionForm() {
  try {
    const config = await fetchPredictionConfig();
    applyPredictionConfigToForm(config);
  } catch (err) {
    console.error('Failed to load prediction config:', err);
  }
}

export function applyPredictionConfigToForm(config) {
  sensorsState = Array.isArray(config.sensors) ? config.sensors.map(s => ({ ...s })) : [];
  derivedState = Array.isArray(config.derived)
    ? config.derived.map(d => ({ name: d.name ?? '', formula: Array.isArray(d.formula) ? [...d.formula] : [] }))
    : [];
  predictors = Array.isArray(config.predictors) ? config.predictors.map(p => ({ ...p })) : [];

  renderSensorList();
  renderDerivedList();
  refreshSensorOptions();
  renderPvConfig(config.pvConfig ?? null);
}

/**
 * Recompute the names usable as predictor/PV/derived-term references and
 * refresh every control that offers them. Called whenever sensors or derived
 * sensors change.
 */
function refreshSensorOptions() {
  sensorOptions = [...new Set(
    [...sensorsState.map(s => s.name || s.id), ...derivedState.map(d => d.name)].filter(Boolean)
  )];

  const pvSelect = document.getElementById('pred-pv-sensor');
  if (pvSelect) {
    const current = pvSelect.value;
    pvSelect.innerHTML = '<option value="" disabled selected>Select a sensor…</option>';
    // An unresolved selection stays selectable so a deleted/renamed sensor
    // is never silently swapped for the fallback on the next save.
    const options = current && !sensorOptions.includes(current) ? [...sensorOptions, current] : sensorOptions;
    for (const name of options) {
      const opt = document.createElement('option');
      opt.textContent = name;
      opt.value = name;
      pvSelect.appendChild(opt);
    }
    if (current) pvSelect.value = current;
  }

  renderPredictorList();
}

/**
 * Follow a rename through everything that references sensor names: predictor
 * targets, derived formulas, and the PV sensor select. No-op when another
 * sensor or derived sensor still provides the old name (sensors sharing a
 * name are summed, so that is not a rename of the name itself).
 */
function cascadeRename(oldName, newName) {
  if (!oldName || !newName || oldName === newName) return;
  const stillProvided = sensorsState.some(s => (s.name || s.id) === oldName)
    || derivedState.some(d => d.name === oldName);
  if (stillProvided) return;

  for (const p of predictors) {
    if (p.sensor === oldName) p.sensor = newName;
  }
  for (const d of derivedState) {
    d.formula = d.formula.map(term => term.slice(1) === oldName ? term[0] + newName : term);
  }
  const pvSelect = document.getElementById('pred-pv-sensor');
  if (pvSelect && pvSelect.value === oldName) {
    // refreshSensorOptions() rebuilds the options from the renamed state and
    // re-applies this value.
    const opt = document.createElement('option');
    opt.textContent = newName;
    opt.value = newName;
    pvSelect.appendChild(opt);
    pvSelect.value = newName;
  }
}

export function wirePredictionForm({ onForecastAll, onPvForecast }) {
  for (const el of document.querySelectorAll('[data-predictions-only="true"]')) {
    el.addEventListener('input', debouncedSave);
    el.addEventListener('change', debouncedSave);
  }

  document.getElementById('pred-add-predictor')
    ?.addEventListener('click', () => {
      predictors.push(defaultPredictor('historical'));
      renderPredictorList();
      debouncedSave();
    });

  document.getElementById('pred-add-sensor')
    ?.addEventListener('click', () => {
      sensorsState.push({ id: '', name: '', unit: 'kWh' });
      renderSensorList();
      debouncedSave();
    });

  document.getElementById('pred-add-derived')
    ?.addEventListener('click', () => {
      derivedState.push({ name: '', formula: [] });
      renderDerivedList();
      debouncedSave();
    });

  initValidation({ readFormValues: readPredictionFormValues, applyValidatedPredictor, setComparisonStatus });

  document.getElementById('pred-load-forecast')
    ?.addEventListener('click', onForecastAll);
  document.getElementById('pred-pv-forecast')
    ?.addEventListener('click', onPvForecast);
}

export async function savePredictionFormToServer() {
  const partial = readPredictionFormValues();
  await savePredictionConfig(partial);
}

async function savePredictionFormSilently() {
  try {
    await savePredictionFormToServer();
  } catch (err) {
    console.error('Failed to save prediction config:', err);
  }
}

export function readPredictionFormValues() {
  // Blank coordinate fields stay null so clearing them disables the
  // location-based forecasts instead of pointing them at (0, 0).
  const coordOrNull = (id) => {
    const value = parseFloat(getVal(id));
    return Number.isFinite(value) ? value : null;
  };

  const pvConfig = {
    pvSensor: getVal('pred-pv-sensor') || 'Solar Generation',
    latitude: coordOrNull('pred-pv-lat'),
    longitude: coordOrNull('pred-pv-lon'),
    historyDays: parseInt(getVal('pred-pv-history'), 10) || 14,
    pvMode: getVal('pred-pv-mode') || 'hourly',
    pvModel: getVal('pred-pv-model') || 'clearSkyRatio',
  };

  return {
    sensors: sensorsState.map(sanitizeSensor).filter(s => s.id.length > 0),
    derived: derivedState.map(sanitizeDerived).filter(d => d.name.length > 0),
    predictors: predictors.map(sanitizePredictor),
    pvConfig,
  };
}

function sanitizeSensor(s) {
  const id = (s.id ?? '').trim();
  return {
    id,
    name: (s.name ?? '').trim() || id,
    unit: s.unit === 'kWh' ? 'kWh' : 'Wh',
  };
}

function sanitizeDerived(d) {
  return {
    name: (d.name ?? '').trim(),
    formula: (d.formula ?? []).filter(term => typeof term === 'string' && term.length > 1),
  };
}

/**
 * Update the predictor of this type targeting this sensor with validated
 * parameters, or add one if none exists yet. Used by the validation
 * table's "Use" button. `predictor` is a full config-shape predictor
 * ({ type: 'historical'|'temperature', sensor, ...params }).
 */
export async function applyValidatedPredictor(predictor) {
  const type = predictor.type ?? 'historical';
  const existing = predictors.find(p => p.type === type && p.sensor === predictor.sensor);
  if (existing) {
    Object.assign(existing, predictor);
  } else {
    predictors.push({ ...predictor, type });
  }
  renderPredictorList();
  await savePredictionFormToServer();
}

function defaultPredictor(type) {
  if (type === 'fixed') return { type: 'fixed', load_W: 200 };
  if (type === 'temperature') {
    return { type: 'temperature', sensor: sensorOptions[0] ?? '', lookbackWeeks: 8, dayFilter: 'weekday-weekend', bins: 4 };
  }
  return { type: 'historical', sensor: sensorOptions[0] ?? '', lookbackWeeks: 4, dayFilter: 'weekday-weekend', aggregation: 'mean' };
}

function sanitizePredictor(p) {
  if (p.type === 'fixed') {
    const load = Number(p.load_W);
    return { type: 'fixed', load_W: Number.isFinite(load) && load >= 0 ? load : 0 };
  }
  const lookback = parseInt(p.lookbackWeeks, 10);
  if (p.type === 'temperature') {
    const bins = parseInt(p.bins, 10);
    return {
      type: 'temperature',
      sensor: p.sensor ?? '',
      lookbackWeeks: Number.isFinite(lookback) && lookback >= 1 && lookback <= 12 ? lookback : 8,
      dayFilter: p.dayFilter || 'weekday-weekend',
      bins: Number.isFinite(bins) && bins >= 2 && bins <= 8 ? bins : 4,
    };
  }
  return {
    type: 'historical',
    sensor: p.sensor ?? '',
    lookbackWeeks: Number.isFinite(lookback) && lookback >= 1 ? lookback : 4,
    dayFilter: p.dayFilter || 'weekday-weekend',
    aggregation: p.aggregation || 'mean',
  };
}

function renderPredictorList() {
  const container = document.getElementById('pred-predictor-list');
  if (!container) return;
  container.innerHTML = '';

  if (predictors.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'text-sm text-slate-400 dark:text-slate-500';
    empty.textContent = 'No predictors configured — add one to enable the load forecast.';
    container.appendChild(empty);
    return;
  }

  predictors.forEach((p, i) => container.appendChild(buildPredictorCard(p, i)));
}

const FIELD_LABEL_CLASS = 'block text-xs font-medium text-slate-400 dark:text-slate-500 mb-1 tracking-wide';

function buildPredictorCard(predictor, index) {
  const card = document.createElement('div');
  card.className = 'rounded-lg border border-slate-200 dark:border-white/10 p-3 space-y-3';
  card.dataset.predictorIndex = String(index);

  const sensorField = `
      <label class="block text-sm">
        <span class="${FIELD_LABEL_CLASS}">Sensor</span>
        <select data-field="sensor" class="form-select"></select>
      </label>`;
  const lookbackField = (max) => `
        <label class="block text-sm">
          <span class="${FIELD_LABEL_CLASS}">Lookback (weeks)</span>
          <input data-field="lookbackWeeks" type="number" min="1"${max ? ` max="${max}"` : ''} class="form-input" />
        </label>`;
  const dayFilterField = `
      <label class="block text-sm">
        <span class="${FIELD_LABEL_CLASS}">Day Filter</span>
        <select data-field="dayFilter" class="form-select">
          <option value="same">Same day of week</option>
          <option value="weekday-weekend">Weekday / Weekend</option>
          <option value="weekday-sat-sun">Weekday / Sat / Sun</option>
          <option value="all">All days</option>
        </select>
      </label>`;

  let fields;
  if (predictor.type === 'fixed') {
    fields = `
      <label class="block text-sm">
        <span class="${FIELD_LABEL_CLASS}">Fixed Load (W)</span>
        <input data-field="load_W" type="number" min="0" step="10" class="form-input" />
      </label>`;
  } else if (predictor.type === 'temperature') {
    fields = `
      ${sensorField}
      <div class="grid grid-cols-2 gap-3">
        ${lookbackField(12)}
        <label class="block text-sm">
          <span class="${FIELD_LABEL_CLASS}">Temperature Bins</span>
          <input data-field="bins" type="number" min="2" max="8" class="form-input" />
        </label>
      </div>
      ${dayFilterField}`;
  } else {
    fields = `
      ${sensorField}
      <div class="grid grid-cols-2 gap-3">
        ${lookbackField()}
        <label class="block text-sm">
          <span class="${FIELD_LABEL_CLASS}">Aggregation</span>
          <select data-field="aggregation" class="form-select">
            <option value="mean">Mean</option>
            <option value="median">Median</option>
          </select>
        </label>
      </div>
      ${dayFilterField}`;
  }

  card.innerHTML = `
    <div class="flex items-center gap-2">
      <select data-field="type" class="form-select flex-1">
        <option value="historical">Historical</option>
        <option value="temperature">Temperature</option>
        <option value="fixed">Fixed</option>
      </select>
      <button type="button" data-remove title="Remove predictor"
        class="shrink-0 rounded p-1.5 text-slate-400 hover:text-red-500 dark:hover:text-red-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">✕</button>
    </div>
    ${fields}
  `;

  // Sensor options are user data; populate via the DOM instead of markup.
  // A stored sensor that no longer resolves stays selectable so it isn't
  // silently replaced by the first option.
  const sensorSelect = card.querySelector('[data-field="sensor"]');
  if (sensorSelect) {
    const options = predictor.sensor && !sensorOptions.includes(predictor.sensor)
      ? [...sensorOptions, predictor.sensor]
      : sensorOptions;
    for (const name of options) {
      const opt = document.createElement('option');
      opt.textContent = name;
      opt.value = name;
      sensorSelect.appendChild(opt);
    }
  }

  for (const el of card.querySelectorAll('[data-field]')) {
    const field = el.dataset.field;
    if (field !== 'type' && predictor[field] != null) el.value = predictor[field];

    const handler = () => {
      if (field === 'type') {
        if (el.value !== predictor.type) {
          predictors[index] = defaultPredictor(el.value);
          renderPredictorList();
          debouncedSave();
        }
        return;
      }
      predictor[field] = el.value;
      debouncedSave();
    };
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
  }
  card.querySelector('[data-field="type"]').value = predictor.type;

  // At least one predictor must remain: the server rejects an empty list.
  const removeBtn = card.querySelector('[data-remove]');
  if (predictors.length === 1) {
    removeBtn.disabled = true;
    removeBtn.title = 'At least one predictor is required';
  }
  removeBtn.addEventListener('click', () => {
    predictors.splice(index, 1);
    renderPredictorList();
    debouncedSave();
  });

  return card;
}

// ----------------------------- Sensor list --------------------------------

function renderSensorList() {
  const container = document.getElementById('pred-sensor-list');
  if (!container) return;
  container.innerHTML = '';

  if (sensorsState.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'text-sm text-slate-400 dark:text-slate-500';
    empty.textContent = 'No sensors configured.';
    container.appendChild(empty);
    return;
  }

  sensorsState.forEach((s, i) => container.appendChild(buildSensorRow(s, i)));
  refreshSensorEntityStates();
}

/** Silently probe HA for every sensor row's current value (errors leave the indicator neutral). */
function refreshSensorEntityStates() {
  for (const row of document.querySelectorAll('#pred-sensor-list [data-sensor-index]')) {
    checkSensorRowEntity(row, { silent: true });
  }
}

async function checkSensorRowEntity(row, { silent = false } = {}) {
  const input = row.querySelector('[data-field="id"]');
  const indicator = row.querySelector('[data-entity-state]');
  const entityId = input?.value.trim();
  if (!entityId || !indicator) return;

  // Drop out-of-order responses (same pattern as the EV sensor inputs).
  const seq = Number(row.dataset.entitySeq ?? 0) + 1;
  row.dataset.entitySeq = String(seq);

  try {
    const state = await fetchHaEntityState(entityId);
    if (Number(row.dataset.entitySeq) !== seq) return;
    const unit = state.attributes?.unit_of_measurement;
    indicator.textContent = `Current value: ${state.state}${unit ? ` ${unit}` : ''}`;
    indicator.className = ENTITY_IND_SUCCESS;
  } catch (err) {
    if (Number(row.dataset.entitySeq) !== seq || silent) return;
    indicator.textContent = `Error: ${err.message}`;
    indicator.className = ENTITY_IND_ERROR;
  }
}

function buildSensorRow(sensor, index) {
  const row = document.createElement('div');
  row.className = 'rounded-lg border border-slate-200 dark:border-white/10 p-2 space-y-2';
  row.dataset.sensorIndex = String(index);
  const label = `Sensor ${index + 1}`;
  row.innerHTML = `
    <div>
      <div class="flex items-center gap-2">
        <input data-field="id" class="form-input font-mono text-xs flex-1" placeholder="sensor.entity_id"
          spellcheck="false" aria-label="${label} entity id" />
        <button type="button" data-remove title="Remove sensor" aria-label="Remove ${label}" class="${REMOVE_BTN_CLASS}">✕</button>
      </div>
      <span data-entity-state class="${ENTITY_IND_NEUTRAL}"></span>
    </div>
    <div class="flex gap-2">
      <input data-field="name" class="form-input text-sm flex-1" placeholder="Display name" aria-label="${label} display name" />
      <select data-field="unit" class="form-select w-24 shrink-0" aria-label="${label} unit">
        <option value="kWh">kWh</option>
        <option value="Wh">Wh</option>
      </select>
    </div>
  `;

  for (const el of row.querySelectorAll('[data-field]')) {
    const field = el.dataset.field;
    if (sensor[field] != null) el.value = sensor[field];

    const handler = () => {
      const prevName = sensor.name || sensor.id;
      sensor[field] = el.value;
      // Renames change the names offered to predictors, PV, and derived terms;
      // references to the old name follow it.
      if (field === 'name' || field === 'id') {
        cascadeRename(prevName, sensor.name || sensor.id);
        refreshSensorOptions();
        renderDerivedList();
      }
      debouncedSave();
    };
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
  }

  const idInput = row.querySelector('[data-field="id"]');
  const indicator = row.querySelector('[data-entity-state]');
  idInput.addEventListener('input', () => {
    // Invalidate any in-flight entity check so a slow response for the old id
    // cannot label the new one.
    row.dataset.entitySeq = String(Number(row.dataset.entitySeq ?? 0) + 1);
    indicator.textContent = '';
    indicator.className = ENTITY_IND_NEUTRAL;
  });
  idInput.addEventListener('blur', () => checkSensorRowEntity(row));

  row.querySelector('[data-remove]').addEventListener('click', () => {
    sensorsState.splice(index, 1);
    renderSensorList();
    refreshSensorOptions();
    debouncedSave();
  });

  return row;
}

// ----------------------------- Derived list -------------------------------

function renderDerivedList() {
  const container = document.getElementById('pred-derived-list');
  if (!container) return;
  container.innerHTML = '';
  derivedState.forEach((d, i) => container.appendChild(buildDerivedRow(d, i)));
}

/** Names a derived sensor at this position may reference: HA sensors plus derived sensors defined before it. */
function derivedTermOptions(index) {
  return [...new Set(
    [...sensorsState.map(s => s.name || s.id), ...derivedState.slice(0, index).map(d => d.name)].filter(Boolean)
  )];
}

function buildDerivedRow(derivedSensor, index) {
  const row = document.createElement('div');
  row.className = 'rounded-lg border border-slate-200 dark:border-white/10 p-2 space-y-2';
  row.dataset.derivedIndex = String(index);
  const label = `Derived sensor ${index + 1}`;
  row.innerHTML = `
    <div class="flex items-center gap-2">
      <input data-field="name" class="form-input text-sm flex-1" placeholder="Derived sensor name" aria-label="${label} name" />
      <button type="button" data-remove title="Remove derived sensor" aria-label="Remove ${label}" class="${REMOVE_BTN_CLASS}">✕</button>
    </div>
    <div data-terms class="space-y-1"></div>
    <button type="button" data-add-term aria-label="Add term to ${label}"
      class="text-xs font-medium text-sky-600 dark:text-sky-400 hover:underline">+ Add term</button>
  `;

  const nameInput = row.querySelector('[data-field="name"]');
  nameInput.value = derivedSensor.name ?? '';
  const nameHandler = () => {
    const prevName = derivedSensor.name;
    derivedSensor.name = nameInput.value;
    cascadeRename(prevName, derivedSensor.name);
    refreshSensorOptions();
    debouncedSave();
  };
  nameInput.addEventListener('input', nameHandler);
  nameInput.addEventListener('change', nameHandler);
  // Refresh the other rows' term dropdowns once typing is done — doing it per
  // keystroke would rebuild (and defocus) the input being typed in.
  nameInput.addEventListener('blur', renderDerivedList);

  const termsContainer = row.querySelector('[data-terms]');
  derivedSensor.formula.forEach((_, j) => termsContainer.appendChild(buildTermRow(derivedSensor, index, j)));

  row.querySelector('[data-add-term]').addEventListener('click', () => {
    derivedSensor.formula.push('+' + (derivedTermOptions(index)[0] ?? ''));
    renderDerivedList();
    debouncedSave();
  });

  row.querySelector('[data-remove]').addEventListener('click', () => {
    derivedState.splice(index, 1);
    renderDerivedList();
    refreshSensorOptions();
    debouncedSave();
  });

  return row;
}

function buildTermRow(derivedSensor, derivedIndex, termIndex) {
  const term = derivedSensor.formula[termIndex] ?? '+';
  const sign = term[0] === '-' ? '-' : '+';
  const ref = term.slice(1);

  const label = `Derived sensor ${derivedIndex + 1} term ${termIndex + 1}`;
  const el = document.createElement('div');
  el.className = 'flex items-center gap-2';
  el.innerHTML = `
    <select data-term-sign class="form-select w-16 shrink-0" aria-label="${label} sign">
      <option value="+">+</option>
      <option value="-">−</option>
    </select>
    <select data-term-ref class="form-select flex-1" aria-label="${label} sensor"></select>
    <button type="button" data-term-remove title="Remove term" aria-label="Remove ${label}" class="${REMOVE_BTN_CLASS}">✕</button>
  `;

  const signSelect = el.querySelector('[data-term-sign]');
  signSelect.value = sign;

  const refSelect = el.querySelector('[data-term-ref]');
  const options = derivedTermOptions(derivedIndex);
  // A stored reference that no longer resolves stays selectable so it isn't silently rewritten.
  if (ref && !options.includes(ref)) options.push(ref);
  for (const name of options) {
    const opt = document.createElement('option');
    opt.textContent = name;
    opt.value = name;
    refSelect.appendChild(opt);
  }
  refSelect.value = ref;

  const update = () => {
    derivedSensor.formula[termIndex] = signSelect.value + refSelect.value;
    debouncedSave();
  };
  signSelect.addEventListener('change', update);
  refSelect.addEventListener('change', update);

  el.querySelector('[data-term-remove]').addEventListener('click', () => {
    derivedSensor.formula.splice(termIndex, 1);
    renderDerivedList();
    debouncedSave();
  });

  return el;
}

function renderPvConfig(pvConfig) {
  if (!pvConfig) return;
  setVal('pred-pv-sensor', pvConfig.pvSensor ?? '');
  setVal('pred-pv-lat', pvConfig.latitude ?? '');
  setVal('pred-pv-lon', pvConfig.longitude ?? '');
  setVal('pred-pv-history', pvConfig.historyDays ?? 14);
  const pvMode = pvConfig.pvMode ?? (pvConfig.forecastResolution === 15 ? 'hybrid' : 'hourly'); // fall back for legacy forecastResolution field
  setVal('pred-pv-mode', pvMode);
  setVal('pred-pv-model', pvConfig.pvModel ?? 'clearSkyRatio');
}

function setComparisonStatus(msg, isError = false) {
  const el = document.getElementById('pred-status');
  if (!el) return;
  el.textContent = msg;
  el.className = isError
    ? 'text-sm text-red-600 dark:text-red-400'
    : 'text-sm text-ink-soft dark:text-slate-400';
}

function setVal(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

function getVal(id) {
  return document.getElementById(id)?.value ?? '';
}
