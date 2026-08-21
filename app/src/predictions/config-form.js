import { fetchPredictionConfig, savePredictionConfig } from '../api/api.js';
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
    for (const name of sensorOptions) {
      const opt = document.createElement('option');
      opt.textContent = name;
      opt.value = name;
      pvSelect.appendChild(opt);
    }
    if (current) pvSelect.value = current;
  }

  renderPredictorList();
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
  const pvConfig = {
    pvSensor: getVal('pred-pv-sensor') || 'Solar Generation',
    latitude: parseFloat(getVal('pred-pv-lat')) || 0,
    longitude: parseFloat(getVal('pred-pv-lon')) || 0,
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
 * Update the historical predictor for the given sensor with validated
 * parameters, or add one if none targets that sensor yet. Used by the
 * validation table's "Use" button.
 */
export async function applyValidatedPredictor({ sensor, lookbackWeeks, dayFilter, aggregation }) {
  const existing = predictors.find(p => p.type === 'historical' && p.sensor === sensor);
  if (existing) {
    Object.assign(existing, { lookbackWeeks, dayFilter, aggregation });
  } else {
    predictors.push({ type: 'historical', sensor, lookbackWeeks, dayFilter, aggregation });
  }
  renderPredictorList();
  await savePredictionFormToServer();
}

function defaultPredictor(type) {
  return type === 'fixed'
    ? { type: 'fixed', load_W: 200 }
    : { type: 'historical', sensor: sensorOptions[0] ?? '', lookbackWeeks: 4, dayFilter: 'weekday-weekend', aggregation: 'mean' };
}

function sanitizePredictor(p) {
  if (p.type === 'fixed') {
    const load = Number(p.load_W);
    return { type: 'fixed', load_W: Number.isFinite(load) && load >= 0 ? load : 0 };
  }
  const lookback = parseInt(p.lookbackWeeks, 10);
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

  const fields = predictor.type === 'fixed'
    ? `
      <label class="block text-sm">
        <span class="${FIELD_LABEL_CLASS}">Fixed Load (W)</span>
        <input data-field="load_W" type="number" min="0" step="10" class="form-input" />
      </label>`
    : `
      <label class="block text-sm">
        <span class="${FIELD_LABEL_CLASS}">Sensor</span>
        <select data-field="sensor" class="form-select"></select>
      </label>
      <div class="grid grid-cols-2 gap-3">
        <label class="block text-sm">
          <span class="${FIELD_LABEL_CLASS}">Lookback (weeks)</span>
          <input data-field="lookbackWeeks" type="number" min="1" class="form-input" />
        </label>
        <label class="block text-sm">
          <span class="${FIELD_LABEL_CLASS}">Aggregation</span>
          <select data-field="aggregation" class="form-select">
            <option value="mean">Mean</option>
            <option value="median">Median</option>
          </select>
        </label>
      </div>
      <label class="block text-sm">
        <span class="${FIELD_LABEL_CLASS}">Day Filter</span>
        <select data-field="dayFilter" class="form-select">
          <option value="same">Same day of week</option>
          <option value="weekday-weekend">Weekday / Weekend</option>
          <option value="weekday-sat-sun">Weekday / Sat / Sun</option>
          <option value="all">All days</option>
        </select>
      </label>`;

  card.innerHTML = `
    <div class="flex items-center gap-2">
      <select data-field="type" class="form-select flex-1">
        <option value="historical">Historical</option>
        <option value="fixed">Fixed</option>
      </select>
      <button type="button" data-remove title="Remove predictor"
        class="shrink-0 rounded p-1.5 text-slate-400 hover:text-red-500 dark:hover:text-red-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">✕</button>
    </div>
    ${fields}
  `;

  // Sensor options are user data; populate via the DOM instead of markup.
  const sensorSelect = card.querySelector('[data-field="sensor"]');
  if (sensorSelect) {
    for (const name of sensorOptions) {
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
}

function buildSensorRow(sensor, index) {
  const row = document.createElement('div');
  row.className = 'rounded-lg border border-slate-200 dark:border-white/10 p-2 space-y-2';
  row.dataset.sensorIndex = String(index);
  row.innerHTML = `
    <div class="flex items-center gap-2">
      <input data-field="id" class="form-input font-mono text-xs flex-1" placeholder="sensor.entity_id" spellcheck="false" />
      <button type="button" data-remove title="Remove sensor" class="${REMOVE_BTN_CLASS}">✕</button>
    </div>
    <div class="flex gap-2">
      <input data-field="name" class="form-input text-sm flex-1" placeholder="Display name" />
      <select data-field="unit" class="form-select w-24 shrink-0">
        <option value="kWh">kWh</option>
        <option value="Wh">Wh</option>
      </select>
    </div>
  `;

  for (const el of row.querySelectorAll('[data-field]')) {
    const field = el.dataset.field;
    if (sensor[field] != null) el.value = sensor[field];

    const handler = () => {
      sensor[field] = el.value;
      // Renames change the names offered to predictors, PV, and derived terms.
      if (field === 'name' || field === 'id') refreshSensorOptions();
      debouncedSave();
    };
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
  }

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
  row.innerHTML = `
    <div class="flex items-center gap-2">
      <input data-field="name" class="form-input text-sm flex-1" placeholder="Derived sensor name" />
      <button type="button" data-remove title="Remove derived sensor" class="${REMOVE_BTN_CLASS}">✕</button>
    </div>
    <div data-terms class="space-y-1"></div>
    <button type="button" data-add-term
      class="text-xs font-medium text-sky-600 dark:text-sky-400 hover:underline">+ Add term</button>
  `;

  const nameInput = row.querySelector('[data-field="name"]');
  nameInput.value = derivedSensor.name ?? '';
  const nameHandler = () => {
    derivedSensor.name = nameInput.value;
    refreshSensorOptions();
    debouncedSave();
  };
  nameInput.addEventListener('input', nameHandler);
  nameInput.addEventListener('change', nameHandler);

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

  const el = document.createElement('div');
  el.className = 'flex items-center gap-2';
  el.innerHTML = `
    <select data-term-sign class="form-select w-16 shrink-0">
      <option value="+">+</option>
      <option value="-">−</option>
    </select>
    <select data-term-ref class="form-select flex-1"></select>
    <button type="button" data-term-remove title="Remove term" class="${REMOVE_BTN_CLASS}">✕</button>
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
