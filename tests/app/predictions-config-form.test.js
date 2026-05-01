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
  hydratePredictionForm,
  readPredictionFormValues,
  savePredictionFormToServer,
  wirePredictionForm,
} from '../../app/src/predictions/config-form.js';

function setupDom() {
  document.body.innerHTML = `
    <textarea id="pred-sensors" data-predictions-only="true"></textarea>
    <textarea id="pred-derived" data-predictions-only="true"></textarea>
    <select id="pred-active-type" data-predictions-only="true">
      <option value="historical">Historical</option>
      <option value="fixed">Fixed</option>
    </select>
    <select id="pred-active-sensor" data-predictions-only="true"></select>
    <input id="pred-fixed-load-w" data-predictions-only="true" />
    <div id="pred-fixed-fields"></div>
    <div id="pred-historical-fields"></div>
    <input id="pred-active-lookback" data-predictions-only="true" />
    <select id="pred-active-filter" data-predictions-only="true">
      <option value="same">same</option>
      <option value="weekday-weekend">weekday-weekend</option>
    </select>
    <select id="pred-active-agg" data-predictions-only="true">
      <option value="mean">mean</option>
      <option value="median">median</option>
    </select>
    <select id="pred-pv-sensor" data-predictions-only="true"></select>
    <input id="pred-pv-lat" data-predictions-only="true" />
    <input id="pred-pv-lon" data-predictions-only="true" />
    <input id="pred-pv-history" data-predictions-only="true" />
    <select id="pred-pv-mode" data-predictions-only="true">
      <option value="hourly">hourly</option>
      <option value="hybrid">hybrid</option>
    </select>
    <button id="pred-load-forecast" type="button"></button>
    <button id="pred-pv-forecast" type="button"></button>
    <input id="forecast-chart-15m" type="checkbox" />
    <button id="pred-settings-toggle" type="button"></button>
    <div id="pred-settings-body" class="hidden"></div>
    <span id="pred-settings-toggle-icon"></span>
    <div id="pred-status"></div>
    <input id="unowned-input" />
  `;
}

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

  it('hydrates predictor and PV form fields from server config', async () => {
    fetchPredictionConfig.mockResolvedValue({
      sensors: [{ id: 'sensor.grid', name: 'Grid Import' }],
      derived: [{ name: 'Total Load' }],
      activeType: 'fixed',
      fixedPredictor: { load_W: 420 },
      historicalPredictor: { sensor: 'Grid Import', lookbackWeeks: 3, dayFilter: 'same', aggregation: 'median' },
      pvConfig: { pvSensor: 'Total Load', latitude: 51.1, longitude: 3.7, historyDays: 9, forecastResolution: 15 },
    });

    await hydratePredictionForm();

    expect(document.getElementById('pred-fixed-load-w').value).toBe('420');
    expect(document.getElementById('pred-active-sensor').options).toHaveLength(3);
    expect([...document.getElementById('pred-active-sensor').options].map(opt => opt.value)).toContain('Grid Import');
    expect(document.getElementById('pred-pv-sensor').value).toBe('Total Load');
    expect(document.getElementById('pred-pv-mode').value).toBe('hybrid');
    expect(document.getElementById('pred-fixed-fields').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('pred-historical-fields').classList.contains('hidden')).toBe(true);
  });

  it('reads and saves only valid prediction form values', async () => {
    document.getElementById('pred-sensors').value = '[{"id":"sensor.grid","name":"Grid"}]';
    document.getElementById('pred-derived').value = 'not json';
    document.getElementById('pred-active-type').value = 'historical';
    document.getElementById('pred-active-sensor').innerHTML = '<option value="Grid">Grid</option>';
    document.getElementById('pred-active-sensor').value = 'Grid';
    document.getElementById('pred-active-lookback').value = '5';
    document.getElementById('pred-active-filter').value = 'weekday-weekend';
    document.getElementById('pred-active-agg').value = 'median';
    document.getElementById('pred-pv-lat').value = '51.1';
    document.getElementById('pred-pv-lon').value = '3.7';
    document.getElementById('pred-pv-history').value = '10';
    document.getElementById('pred-pv-mode').value = 'hybrid';
    savePredictionConfig.mockResolvedValue({});

    const values = readPredictionFormValues();
    await savePredictionFormToServer();

    expect(values).toMatchObject({
      sensors: [{ id: 'sensor.grid', name: 'Grid' }],
      activeType: 'historical',
      historicalPredictor: {
        sensor: 'Grid',
        lookbackWeeks: 5,
        dayFilter: 'weekday-weekend',
        aggregation: 'median',
      },
      pvConfig: {
        latitude: 51.1,
        longitude: 3.7,
        historyDays: 10,
        pvMode: 'hybrid',
      },
    });
    expect(values).not.toHaveProperty('derived');
    expect(savePredictionConfig).toHaveBeenCalledWith(values);
  });

  it('wires prediction-owned controls, buttons, and settings toggle', async () => {
    const onForecastAll = vi.fn();
    const onPvForecast = vi.fn();
    const onForecastResolutionChange = vi.fn();
    savePredictionConfig.mockResolvedValue({});

    wirePredictionForm({ onForecastAll, onPvForecast, onForecastResolutionChange });

    document.getElementById('pred-active-type').value = 'fixed';
    document.getElementById('pred-active-type').dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('unowned-input').dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(600);
    await Promise.resolve();

    expect(savePredictionConfig).toHaveBeenCalledTimes(1);
    expect(document.getElementById('pred-fixed-fields').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('pred-historical-fields').classList.contains('hidden')).toBe(true);
    expect(initValidation).toHaveBeenCalled();

    document.getElementById('pred-load-forecast').click();
    document.getElementById('pred-pv-forecast').click();
    document.getElementById('forecast-chart-15m').dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('pred-settings-toggle').click();

    expect(onForecastAll).toHaveBeenCalledTimes(1);
    expect(onPvForecast).toHaveBeenCalledTimes(1);
    expect(onForecastResolutionChange).toHaveBeenCalledTimes(1);
    expect(document.getElementById('pred-settings-body').classList.contains('hidden')).toBe(false);
  });
});
