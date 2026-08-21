import { fetchPredictionConfig, savePredictionConfig } from '../api/api.js';
import { debounce } from '../utils.js';
import { initValidation } from '../predictions-validation.js';

// Predictor list state; the forecast is the per-slot sum of these.
let predictors = [];
let sensorOptions = [];

const debouncedSave = debounce(savePredictionFormSilently, 600);

export async function hydratePredictionForm() {
  try {
    const config = await fetchPredictionConfig();
    applyPredictionConfigToForm(config);
  } catch (err) {
    console.error('Failed to load prediction config:', err);
  }
}

export function applyPredictionConfigToForm(config) {
  setVal('pred-sensors', config.sensors ? JSON.stringify(config.sensors, null, 2) : '');
  setVal('pred-derived', config.derived ? JSON.stringify(config.derived, null, 2) : '');

  const allSensors = [...(config.sensors || []), ...(config.derived || [])];
  sensorOptions = allSensors.map(s => s.name || s.id);

  const pvSelect = document.getElementById('pred-pv-sensor');
  if (pvSelect) {
    pvSelect.innerHTML = '<option value="" disabled selected>Select a sensor…</option>';
    for (const name of sensorOptions) {
      const opt = document.createElement('option');
      opt.textContent = name;
      opt.value = name;
      pvSelect.appendChild(opt);
    }
  }

  predictors = Array.isArray(config.predictors) ? config.predictors.map(p => ({ ...p })) : [];
  renderPredictorList();
  renderPvConfig(config.pvConfig ?? null);
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
  const sensors = parseSilently(getVal('pred-sensors'));
  const derived = parseSilently(getVal('pred-derived'));

  const pvConfig = {
    pvSensor: getVal('pred-pv-sensor') || 'Solar Generation',
    latitude: parseFloat(getVal('pred-pv-lat')) || 0,
    longitude: parseFloat(getVal('pred-pv-lon')) || 0,
    historyDays: parseInt(getVal('pred-pv-history'), 10) || 14,
    pvMode: getVal('pred-pv-mode') || 'hourly',
    pvModel: getVal('pred-pv-model') || 'clearSkyRatio',
  };

  return {
    ...(sensors !== null ? { sensors } : {}),
    ...(derived !== null ? { derived } : {}),
    predictors: predictors.map(sanitizePredictor),
    pvConfig,
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
    empty.textContent = 'No predictors configured — the load forecast will be 0 W.';
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
        class="shrink-0 rounded p-1.5 text-slate-400 hover:text-red-500 dark:hover:text-red-400 transition-colors">✕</button>
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

  card.querySelector('[data-remove]').addEventListener('click', () => {
    predictors.splice(index, 1);
    renderPredictorList();
    debouncedSave();
  });

  return card;
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

function parseSilently(str) {
  try { return JSON.parse(str); }
  catch { return null; }
}
