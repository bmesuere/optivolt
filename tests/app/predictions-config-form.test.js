// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/src/api/api.js', () => ({
  fetchPredictionConfig: vi.fn(),
  savePredictionConfig: vi.fn(),
  fetchHaEntityState: vi.fn(),
}));

vi.mock('../../app/src/predictions-validation.js', () => ({
  initValidation: vi.fn(),
}));

import { fetchHaEntityState, fetchPredictionConfig, savePredictionConfig } from '../../app/src/api/api.js';
import { initValidation } from '../../app/src/predictions-validation.js';
import {
  applyPredictionConfigToForm,
  applyValidatedPredictor,
  hydratePredictionForm,
  readPredictionFormValues,
  savePredictionFormToServer,
  wirePredictionForm,
} from '../../app/src/predictions/config-form.js';

function setupDom() {
  document.body.innerHTML = `
    <div id="pred-sensor-list"></div>
    <button id="pred-add-sensor" type="button"></button>
    <div id="pred-derived-list"></div>
    <button id="pred-add-derived" type="button"></button>
    <div id="pred-predictor-list"></div>
    <button id="pred-add-predictor" type="button"></button>
    <select id="pred-pv-sensor" data-predictions-only="true"></select>
    <input id="pred-pv-lat" data-predictions-only="true" />
    <input id="pred-pv-lon" data-predictions-only="true" />
    <input id="pred-pv-history" data-predictions-only="true" />
    <select id="pred-pv-mode" data-predictions-only="true">
      <option value="hourly">hourly</option>
      <option value="hybrid">hybrid</option>
    </select>
    <select id="pred-pv-model" data-predictions-only="true">
      <option value="clearSkyRatio">clearSkyRatio</option>
      <option value="robustLinear">robustLinear</option>
    </select>
    <button id="pred-load-forecast" type="button"></button>
    <button id="pred-pv-forecast" type="button"></button>
    <div id="pred-status"></div>
    <input id="unowned-input" />
  `;
}

const baseConfig = {
  sensors: [
    { id: 'sensor.grid', name: 'Grid Import', unit: 'kWh' },
    { id: 'sensor.solar', name: 'Solar', unit: 'Wh' },
  ],
  derived: [{ name: 'Total Load', formula: ['+Grid Import', '-Solar'] }],
  predictors: [
    { type: 'historical', sensor: 'Grid Import', lookbackWeeks: 3, dayFilter: 'same', aggregation: 'median' },
    { type: 'fixed', load_W: 420 },
  ],
  pvConfig: { pvSensor: 'Total Load', latitude: 51.1, longitude: 3.7, historyDays: 9, forecastResolution: 15, pvModel: 'robustLinear' },
};

describe('prediction config form', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    setupDom();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('hydrates sensor rows, derived rows, predictor cards, and PV fields from server config', async () => {
    fetchPredictionConfig.mockResolvedValue(baseConfig);

    await hydratePredictionForm();

    const sensorRows = document.querySelectorAll('#pred-sensor-list [data-sensor-index]');
    expect(sensorRows).toHaveLength(2);
    expect(sensorRows[0].querySelector('[data-field="id"]').value).toBe('sensor.grid');
    expect(sensorRows[0].querySelector('[data-field="name"]').value).toBe('Grid Import');
    expect(sensorRows[0].querySelector('[data-field="unit"]').value).toBe('kWh');
    expect(sensorRows[1].querySelector('[data-field="unit"]').value).toBe('Wh');

    const derivedRows = document.querySelectorAll('#pred-derived-list [data-derived-index]');
    expect(derivedRows).toHaveLength(1);
    expect(derivedRows[0].querySelector('[data-field="name"]').value).toBe('Total Load');
    const terms = derivedRows[0].querySelectorAll('[data-terms] > div');
    expect(terms).toHaveLength(2);
    expect(terms[0].querySelector('[data-term-sign]').value).toBe('+');
    expect(terms[0].querySelector('[data-term-ref]').value).toBe('Grid Import');
    expect(terms[1].querySelector('[data-term-sign]').value).toBe('-');
    expect(terms[1].querySelector('[data-term-ref]').value).toBe('Solar');

    const cards = document.querySelectorAll('#pred-predictor-list [data-predictor-index]');
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector('[data-field="sensor"]').value).toBe('Grid Import');
    expect(document.getElementById('pred-pv-sensor').value).toBe('Total Load');
    expect(document.getElementById('pred-pv-mode').value).toBe('hybrid');
  });

  it('reads sanitized sensors, derived, predictors, and PV values', async () => {
    applyPredictionConfigToForm({
      ...baseConfig,
      sensors: [
        { id: 'sensor.grid', name: 'Grid Import', unit: 'kWh' },
        { id: '  ', name: 'Half-typed row', unit: 'Wh' },
        { id: 'sensor.noname', name: '', unit: 'Wh' },
      ],
      derived: [
        { name: 'Total Load', formula: ['+Grid Import', '+'] },
        { name: '', formula: ['+Grid Import'] },
      ],
    });
    document.getElementById('pred-pv-lat').value = '51.1';
    document.getElementById('pred-pv-lon').value = '3.7';
    document.getElementById('pred-pv-history').value = '10';
    savePredictionConfig.mockResolvedValue({});

    const values = readPredictionFormValues();
    await savePredictionFormToServer();

    expect(values.sensors).toEqual([
      { id: 'sensor.grid', name: 'Grid Import', unit: 'kWh' },
      { id: 'sensor.noname', name: 'sensor.noname', unit: 'Wh' },
    ]);
    expect(values.derived).toEqual([
      { name: 'Total Load', formula: ['+Grid Import'] },
    ]);
    expect(values.pvConfig).toMatchObject({ latitude: 51.1, longitude: 3.7, historyDays: 10 });
    expect(savePredictionConfig).toHaveBeenCalledWith(values);
  });

  it('adds and removes sensors, updating predictor sensor options', async () => {
    applyPredictionConfigToForm(baseConfig);
    savePredictionConfig.mockResolvedValue({});
    wirePredictionForm({ onForecastAll: vi.fn(), onPvForecast: vi.fn() });

    document.getElementById('pred-add-sensor').click();
    const rows = document.querySelectorAll('[data-sensor-index]');
    expect(rows).toHaveLength(3);

    const idInput = rows[2].querySelector('[data-field="id"]');
    idInput.value = 'sensor.ac_energy';
    idInput.dispatchEvent(new Event('input', { bubbles: true }));
    const nameInput = rows[2].querySelector('[data-field="name"]');
    nameInput.value = 'Bedroom AC';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));

    // The new name becomes available in predictor cards and the PV select.
    const sensorSelect = document.querySelector('[data-predictor-index="0"] [data-field="sensor"]');
    expect([...sensorSelect.options].map(o => o.value)).toContain('Bedroom AC');
    expect([...document.getElementById('pred-pv-sensor').options].map(o => o.value)).toContain('Bedroom AC');

    vi.advanceTimersByTime(600);
    await Promise.resolve();
    const saved = savePredictionConfig.mock.calls.at(-1)[0].sensors;
    expect(saved).toHaveLength(3);
    expect(saved[2]).toEqual({ id: 'sensor.ac_energy', name: 'Bedroom AC', unit: 'kWh' });

    document.querySelector('[data-sensor-index="2"] [data-remove]').click();
    expect(document.querySelectorAll('[data-sensor-index]')).toHaveLength(2);
    expect([...document.getElementById('pred-pv-sensor').options].map(o => o.value)).not.toContain('Bedroom AC');
  });

  it('cascades a sensor rename to predictors, derived terms, and the PV select', async () => {
    applyPredictionConfigToForm(baseConfig);
    savePredictionConfig.mockResolvedValue({});
    wirePredictionForm({ onForecastAll: vi.fn(), onPvForecast: vi.fn() });

    const nameInput = document.querySelector('[data-sensor-index="0"] [data-field="name"]');
    nameInput.value = 'Grid In';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));

    vi.advanceTimersByTime(600);
    await Promise.resolve();
    const saved = savePredictionConfig.mock.calls.at(-1)[0];
    expect(saved.predictors[0].sensor).toBe('Grid In');
    expect(saved.derived[0].formula).toEqual(['+Grid In', '-Solar']);
    expect(document.querySelector('[data-predictor-index="0"] [data-field="sensor"]').value).toBe('Grid In');
  });

  it('cascades a derived rename and keeps the PV selection following it', async () => {
    applyPredictionConfigToForm(baseConfig); // pvSensor is 'Total Load'
    savePredictionConfig.mockResolvedValue({});

    const nameInput = document.querySelector('[data-derived-index="0"] [data-field="name"]');
    nameInput.value = 'House Load';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));

    vi.advanceTimersByTime(600);
    await Promise.resolve();
    expect(document.getElementById('pred-pv-sensor').value).toBe('House Load');
    expect(savePredictionConfig.mock.calls.at(-1)[0].pvConfig.pvSensor).toBe('House Load');
  });

  it('does not cascade when another sensor still provides the old name', async () => {
    applyPredictionConfigToForm({
      ...baseConfig,
      sensors: [
        { id: 'sensor.dsmr_1', name: 'Grid Import', unit: 'kWh' },
        { id: 'sensor.dsmr_2', name: 'Grid Import', unit: 'kWh' },
      ],
    });
    savePredictionConfig.mockResolvedValue({});

    const nameInput = document.querySelector('[data-sensor-index="0"] [data-field="name"]');
    nameInput.value = 'Grid Import T1';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));

    vi.advanceTimersByTime(600);
    await Promise.resolve();
    expect(savePredictionConfig.mock.calls.at(-1)[0].predictors[0].sensor).toBe('Grid Import');
  });

  it('keeps an unresolved sensor selectable after deletion instead of silently rewriting it', () => {
    applyPredictionConfigToForm(baseConfig);
    savePredictionConfig.mockResolvedValue({});
    wirePredictionForm({ onForecastAll: vi.fn(), onPvForecast: vi.fn() });

    // Delete both sensors; 'Total Load' derives from them but the predictor
    // target 'Grid Import' no longer resolves.
    document.querySelector('[data-sensor-index="1"] [data-remove]').click();
    document.querySelector('[data-sensor-index="0"] [data-remove]').click();

    const sensorSelect = document.querySelector('[data-predictor-index="0"] [data-field="sensor"]');
    expect(sensorSelect.value).toBe('Grid Import');
    expect(readPredictionFormValues().predictors[0].sensor).toBe('Grid Import');
  });

  it('ignores a stale entity check response after the id changed', async () => {
    applyPredictionConfigToForm(baseConfig);
    let resolveSlow;
    fetchHaEntityState.mockReturnValue(new Promise(resolve => { resolveSlow = resolve; }));

    const row = document.querySelector('[data-sensor-index="0"]');
    const idInput = row.querySelector('[data-field="id"]');
    const indicator = row.querySelector('[data-entity-state]');

    idInput.dispatchEvent(new Event('blur', { bubbles: true }));
    idInput.value = 'sensor.other';
    idInput.dispatchEvent(new Event('input', { bubbles: true }));

    resolveSlow({ state: '42', attributes: { unit_of_measurement: 'kWh' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(indicator.textContent).toBe('');
  });

  it('gives every row control an accessible name', () => {
    applyPredictionConfigToForm(baseConfig);
    const controls = document.querySelectorAll(
      '#pred-sensor-list input, #pred-sensor-list select, #pred-sensor-list button, ' +
      '#pred-derived-list input, #pred-derived-list select, #pred-derived-list button'
    );
    expect(controls.length).toBeGreaterThan(0);
    for (const el of controls) {
      expect(el.getAttribute('aria-label'), `${el.tagName} missing aria-label`).toBeTruthy();
    }
  });

  it('shows the entity state on id blur, and an error for a bad entity', async () => {
    fetchHaEntityState.mockRejectedValue(new Error('offline'));
    applyPredictionConfigToForm(baseConfig);
    await Promise.resolve(); // silent on-render probes must not mark rows red

    const row = document.querySelector('[data-sensor-index="0"]');
    const indicator = row.querySelector('[data-entity-state]');
    expect(indicator.textContent).toBe('');

    fetchHaEntityState.mockResolvedValue({ state: '12345.6', attributes: { unit_of_measurement: 'kWh' } });
    row.querySelector('[data-field="id"]').dispatchEvent(new Event('blur', { bubbles: true }));
    await vi.waitFor(() => expect(indicator.textContent).toBe('Current value: 12345.6 kWh'));
    expect(indicator.className).toContain('emerald');

    fetchHaEntityState.mockRejectedValue(new Error('HA returned 404 for entity "sensor.grid"'));
    const idInput = row.querySelector('[data-field="id"]');
    idInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(indicator.textContent).toBe('');
    idInput.dispatchEvent(new Event('blur', { bubbles: true }));
    await vi.waitFor(() => expect(indicator.textContent).toContain('HA returned 404'));
    expect(indicator.className).toContain('red');
  });

  it('edits derived formulas through sign and reference selects', async () => {
    applyPredictionConfigToForm(baseConfig);
    savePredictionConfig.mockResolvedValue({});
    wirePredictionForm({ onForecastAll: vi.fn(), onPvForecast: vi.fn() });

    const row = document.querySelector('[data-derived-index="0"]');
    const firstTerm = row.querySelector('[data-terms] > div');
    firstTerm.querySelector('[data-term-sign]').value = '-';
    firstTerm.querySelector('[data-term-sign]').dispatchEvent(new Event('change', { bubbles: true }));

    row.querySelector('[data-add-term]').click();
    const terms = document.querySelectorAll('[data-derived-index="0"] [data-terms] > div');
    expect(terms).toHaveLength(3);

    vi.advanceTimersByTime(600);
    await Promise.resolve();
    const saved = savePredictionConfig.mock.calls.at(-1)[0].derived;
    expect(saved[0].formula[0]).toBe('-Grid Import');
    expect(saved[0].formula[2]).toBe('+Grid Import');
  });

  it('offers a derived sensor only the names defined before it', () => {
    applyPredictionConfigToForm({
      ...baseConfig,
      derived: [
        { name: 'Total Load', formula: ['+Grid Import'] },
        { name: 'Residual Load', formula: ['+Total Load'] },
      ],
    });

    const rows = document.querySelectorAll('[data-derived-index]');
    const firstOptions = [...rows[0].querySelectorAll('[data-term-ref] option')].map(o => o.value);
    const secondOptions = [...rows[1].querySelectorAll('[data-term-ref] option')].map(o => o.value);

    expect(firstOptions).not.toContain('Total Load');
    expect(firstOptions).not.toContain('Residual Load');
    expect(secondOptions).toContain('Total Load');
    expect(secondOptions).not.toContain('Residual Load');
  });

  it('renders a temperature card with bins and sanitizes its values', async () => {
    applyPredictionConfigToForm({
      ...baseConfig,
      predictors: [{ type: 'temperature', sensor: 'Total Load', lookbackWeeks: 8, dayFilter: 'weekday-weekend', bins: 4 }],
    });

    const card = document.querySelector('[data-predictor-index="0"]');
    expect(card.querySelector('[data-field="type"]').value).toBe('temperature');
    expect(card.querySelector('[data-field="sensor"]').value).toBe('Total Load');
    expect(card.querySelector('[data-field="bins"]').value).toBe('4');
    expect(card.querySelector('[data-field="aggregation"]')).toBeNull();

    const values = readPredictionFormValues();
    expect(values.predictors).toEqual([
      { type: 'temperature', sensor: 'Total Load', lookbackWeeks: 8, dayFilter: 'weekday-weekend', bins: 4 },
    ]);
  });

  it('clamps out-of-range temperature parameters to defaults on read', () => {
    applyPredictionConfigToForm({
      ...baseConfig,
      predictors: [{ type: 'temperature', sensor: 'Total Load', lookbackWeeks: 99, dayFilter: 'weekday-weekend', bins: 0 }],
    });

    const values = readPredictionFormValues();
    expect(values.predictors[0].lookbackWeeks).toBe(8);
    expect(values.predictors[0].bins).toBe(4);
  });

  it('edits a card field and saves the updated predictor', async () => {
    applyPredictionConfigToForm(baseConfig);
    savePredictionConfig.mockResolvedValue({});
    wirePredictionForm({ onForecastAll: vi.fn(), onPvForecast: vi.fn() });

    const lookback = document.querySelector('[data-predictor-index="0"] [data-field="lookbackWeeks"]');
    lookback.value = '6';
    lookback.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(600);
    await Promise.resolve();

    expect(savePredictionConfig).toHaveBeenCalledTimes(1);
    expect(savePredictionConfig.mock.calls[0][0].predictors[0].lookbackWeeks).toBe(6);
  });

  it('adds and removes predictors', async () => {
    applyPredictionConfigToForm(baseConfig);
    savePredictionConfig.mockResolvedValue({});
    wirePredictionForm({ onForecastAll: vi.fn(), onPvForecast: vi.fn() });

    document.getElementById('pred-add-predictor').click();
    expect(document.querySelectorAll('[data-predictor-index]')).toHaveLength(3);

    document.querySelector('[data-predictor-index="1"] [data-remove]').click();
    expect(document.querySelectorAll('[data-predictor-index]')).toHaveLength(2);

    vi.advanceTimersByTime(600);
    await Promise.resolve();

    expect(savePredictionConfig).toHaveBeenCalledTimes(1);
    const saved = savePredictionConfig.mock.calls[0][0].predictors;
    expect(saved).toHaveLength(2);
    expect(saved[0].type).toBe('historical');
    expect(saved[1].type).toBe('historical');
    expect(initValidation).toHaveBeenCalled();
  });

  it('disables removal of the last remaining predictor', async () => {
    applyPredictionConfigToForm({ ...baseConfig, predictors: [{ type: 'fixed', load_W: 100 }] });
    savePredictionConfig.mockResolvedValue({});
    wirePredictionForm({ onForecastAll: vi.fn(), onPvForecast: vi.fn() });

    const removeBtn = document.querySelector('[data-predictor-index="0"] [data-remove]');
    expect(removeBtn.disabled).toBe(true);

    removeBtn.click();
    expect(document.querySelectorAll('[data-predictor-index]')).toHaveLength(1);

    vi.advanceTimersByTime(600);
    await Promise.resolve();
    expect(savePredictionConfig).not.toHaveBeenCalled();

    // Adding a second predictor re-enables removal on both cards.
    document.getElementById('pred-add-predictor').click();
    const buttons = document.querySelectorAll('#pred-predictor-list [data-remove]');
    expect(buttons).toHaveLength(2);
    for (const btn of buttons) expect(btn.disabled).toBe(false);
  });

  it('applyValidatedPredictor updates a matching predictor or appends a new one', async () => {
    applyPredictionConfigToForm(baseConfig);
    savePredictionConfig.mockResolvedValue({});

    await applyValidatedPredictor({ sensor: 'Grid Import', lookbackWeeks: 8, dayFilter: 'all', aggregation: 'mean' });
    expect(savePredictionConfig.mock.calls[0][0].predictors[0]).toEqual(
      { type: 'historical', sensor: 'Grid Import', lookbackWeeks: 8, dayFilter: 'all', aggregation: 'mean' },
    );

    await applyValidatedPredictor({ sensor: 'Total Load', lookbackWeeks: 2, dayFilter: 'same', aggregation: 'mean' });
    const saved = savePredictionConfig.mock.calls[1][0].predictors;
    expect(saved).toHaveLength(3);
    expect(saved[2]).toEqual({ type: 'historical', sensor: 'Total Load', lookbackWeeks: 2, dayFilter: 'same', aggregation: 'mean' });
  });

  it('wires forecast buttons and ignores unowned inputs', async () => {
    applyPredictionConfigToForm(baseConfig);
    const onForecastAll = vi.fn();
    const onPvForecast = vi.fn();
    savePredictionConfig.mockResolvedValue({});

    wirePredictionForm({ onForecastAll, onPvForecast });

    document.getElementById('unowned-input').dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(600);
    await Promise.resolve();
    expect(savePredictionConfig).not.toHaveBeenCalled();

    document.getElementById('pred-load-forecast').click();
    document.getElementById('pred-pv-forecast').click();

    expect(onForecastAll).toHaveBeenCalledTimes(1);
    expect(onPvForecast).toHaveBeenCalledTimes(1);
  });
});
