// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/src/api/api.js', () => ({
  createPredictionAdjustment: vi.fn(),
  deletePredictionAdjustment: vi.fn(),
  fetchPredictionAdjustments: vi.fn(),
  updatePredictionAdjustment: vi.fn(),
}));

import {
  deletePredictionAdjustment,
  fetchPredictionAdjustments,
  updatePredictionAdjustment,
} from '../../app/src/api/api.js';
import { createForecastChartController } from '../../app/src/predictions/forecast-chart.js';

const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0));

function setupDom() {
  document.body.innerHTML = `
    <input id="forecast-chart-15m" type="checkbox" />
    <div id="prediction-adjustments-count"></div>
    <div id="prediction-adjustments-list"></div>
    <div id="forecast-adjustment-popover" class="hidden">
      <div id="forecast-adjustment-title"></div>
      <div id="forecast-adjustment-range"></div>
      <input id="forecast-adjustment-watts" />
      <input id="forecast-adjustment-start" />
      <input id="forecast-adjustment-end" />
      <div id="forecast-adjustment-error" class="hidden"></div>
      <button id="forecast-adjustment-save" type="button"></button>
      <button id="forecast-adjustment-delete" type="button"></button>
      <button id="forecast-adjustment-cancel" type="button"></button>
      <button class="forecast-adjustment-series" data-adjust-series="load" type="button"></button>
      <button class="forecast-adjustment-series" data-adjust-series="pv" type="button"></button>
      <button class="forecast-adjustment-mode" data-adjust-mode="add" type="button"></button>
      <button class="forecast-adjustment-mode" data-adjust-mode="set" type="button"></button>
    </div>
  `;
  Element.prototype.scrollIntoView = vi.fn();
}

describe('prediction forecast chart controller', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupDom();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('loads, prunes through the API response, and renders active adjustments', async () => {
    const onAdjustmentsChanged = vi.fn();
    const adjustments = [
      { id: 'late', series: 'pv', mode: 'set', value_W: 0, start: '2099-01-01T02:00:00.000Z', end: '2099-01-01T03:00:00.000Z', label: '<unsafe>' },
      { id: 'early', series: 'load', mode: 'add', value_W: 250, start: '2099-01-01T00:00:00.000Z', end: '2099-01-01T01:00:00.000Z' },
    ];
    fetchPredictionAdjustments.mockResolvedValue({ adjustments });
    const controller = createForecastChartController({ getForecasts: () => ({}), onAdjustmentsChanged });

    await controller.loadAdjustments();

    expect(controller.getAdjustments()).toEqual(adjustments);
    expect(onAdjustmentsChanged).toHaveBeenCalledWith(adjustments);
    expect(document.getElementById('prediction-adjustments-count').textContent).toBe('2 active');
    expect([...document.querySelectorAll('#prediction-adjustments-list button')].map(btn => btn.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('Load add +250 W'), expect.stringContaining('PV set to 0 W')])
    );
    expect(document.querySelector('#prediction-adjustments-list b')).toBeNull();
  });

  it('opens an existing adjustment and saves edits through the API', async () => {
    const existing = {
      id: 'adj-1',
      series: 'load',
      mode: 'add',
      value_W: 50,
      start: '2099-01-01T00:00:00.000Z',
      end: '2099-01-01T01:00:00.000Z',
    };
    const updated = { ...existing, value_W: 125 };
    updatePredictionAdjustment.mockResolvedValue({ adjustment: updated, adjustments: [updated] });
    const controller = createForecastChartController({ getForecasts: () => ({}) });
    controller.setAdjustments([existing], { renderForecast: false });
    controller.wireAdjustmentPopover();

    document.querySelector('#prediction-adjustments-list button').click();
    expect(document.getElementById('forecast-adjustment-popover').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('forecast-adjustment-title').textContent).toBe('Edit adjustment');
    expect(document.getElementById('forecast-adjustment-watts').value).toBe('50');

    document.getElementById('forecast-adjustment-watts').value = '125';
    document.getElementById('forecast-adjustment-save').click();
    await flushPromises();

    expect(updatePredictionAdjustment).toHaveBeenCalledWith('adj-1', expect.objectContaining({
      series: 'load',
      mode: 'add',
      value_W: 125,
      start: existing.start,
      end: existing.end,
    }));
    expect(controller.getAdjustments()).toEqual([updated]);
    expect(document.getElementById('forecast-adjustment-popover').classList.contains('hidden')).toBe(true);
  });

  it('deletes an existing adjustment through the API', async () => {
    const existing = {
      id: 'adj-1',
      series: 'pv',
      mode: 'set',
      value_W: 0,
      start: '2099-01-01T00:00:00.000Z',
      end: '2099-01-01T01:00:00.000Z',
    };
    deletePredictionAdjustment.mockResolvedValue({ adjustments: [] });
    const controller = createForecastChartController({ getForecasts: () => ({}) });
    controller.setAdjustments([existing], { renderForecast: false });
    controller.wireAdjustmentPopover();

    document.querySelector('#prediction-adjustments-list button').click();
    document.getElementById('forecast-adjustment-delete').click();
    await flushPromises();

    expect(deletePredictionAdjustment).toHaveBeenCalledWith('adj-1');
    expect(controller.getAdjustments()).toEqual([]);
    expect(document.getElementById('prediction-adjustments-list').textContent).toContain('No active adjustments');
  });
});
