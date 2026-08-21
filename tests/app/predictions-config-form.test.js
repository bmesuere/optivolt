// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/src/api/api.js', () => ({
  fetchPredictionConfig: vi.fn(),
  savePredictionConfig: vi.fn(),
}));

vi.mock('../../app/src/predictions-validation.js', () => ({
  initValidation: vi.fn(),
}));

import { fetchPredictionConfig, savePredictionConfig } from '../../app/src/api/api.js';
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
    <textarea id="pred-sensors" data-predictions-only="true"></textarea>
    <textarea id="pred-derived" data-predictions-only="true"></textarea>
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
  sensors: [{ id: 'sensor.grid', name: 'Grid Import' }],
  derived: [{ name: 'Total Load' }],
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

  it('hydrates predictor cards and PV form fields from server config', async () => {
    fetchPredictionConfig.mockResolvedValue(baseConfig);

    await hydratePredictionForm();

    const cards = document.querySelectorAll('#pred-predictor-list [data-predictor-index]');
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector('[data-field="type"]').value).toBe('historical');
    expect(cards[0].querySelector('[data-field="sensor"]').value).toBe('Grid Import');
    expect(cards[0].querySelector('[data-field="lookbackWeeks"]').value).toBe('3');
    expect(cards[0].querySelector('[data-field="aggregation"]').value).toBe('median');
    expect(cards[1].querySelector('[data-field="type"]').value).toBe('fixed');
    expect(cards[1].querySelector('[data-field="load_W"]').value).toBe('420');
    expect(document.getElementById('pred-pv-sensor').value).toBe('Total Load');
    expect(document.getElementById('pred-pv-mode').value).toBe('hybrid');
    expect(document.getElementById('pred-pv-model').value).toBe('robustLinear');
  });

  it('reads and saves sanitized predictors and PV values', async () => {
    applyPredictionConfigToForm(baseConfig);
    document.getElementById('pred-sensors').value = '[{"id":"sensor.grid","name":"Grid"}]';
    document.getElementById('pred-derived').value = 'not json';
    document.getElementById('pred-pv-lat').value = '51.1';
    document.getElementById('pred-pv-lon').value = '3.7';
    document.getElementById('pred-pv-history').value = '10';
    document.getElementById('pred-pv-mode').value = 'hybrid';
    document.getElementById('pred-pv-model').value = 'robustLinear';
    savePredictionConfig.mockResolvedValue({});

    const values = readPredictionFormValues();
    await savePredictionFormToServer();

    expect(values).toMatchObject({
      sensors: [{ id: 'sensor.grid', name: 'Grid' }],
      predictors: [
        { type: 'historical', sensor: 'Grid Import', lookbackWeeks: 3, dayFilter: 'same', aggregation: 'median' },
        { type: 'fixed', load_W: 420 },
      ],
      pvConfig: {
        latitude: 51.1,
        longitude: 3.7,
        historyDays: 10,
        pvMode: 'hybrid',
        pvModel: 'robustLinear',
      },
    });
    expect(values).not.toHaveProperty('derived');
    expect(savePredictionConfig).toHaveBeenCalledWith(values);
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
    const buttons = document.querySelectorAll('[data-remove]');
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
