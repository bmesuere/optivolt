// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/src/api/api.js', () => ({
  fetchHaEntityState: vi.fn(),
}));

import { fetchHaEntityState } from '../../app/src/api/api.js';
import {
  initDepartureDatetimeMin,
  refreshEvSensorStates,
  updateEvDepartureQuickSet,
  wireEvSensorInputs,
} from '../../app/src/ev-settings.js';

const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0));

function setupEls() {
  document.body.innerHTML = `
    <input id="ev-departure-time" />
    <button id="ev-departure-quick-set" type="button"></button>
    <input id="ev-target-soc" />
    <button id="ev-target-soc-quick-set" type="button"></button>
    <input id="ev-soc-sensor" />
    <input id="ev-plug-sensor" />
    <span id="ev-soc-value"></span>
    <span id="ev-plug-value"></span>
  `;
  return {
    evDepartureTime: document.getElementById('ev-departure-time'),
    evDepartureQuickSet: document.getElementById('ev-departure-quick-set'),
    evTargetSoc: document.getElementById('ev-target-soc'),
    evTargetSocQuickSet: document.getElementById('ev-target-soc-quick-set'),
    evSocSensor: document.getElementById('ev-soc-sensor'),
    evPlugSensor: document.getElementById('ev-plug-sensor'),
    evSocValue: document.getElementById('ev-soc-value'),
    evPlugValue: document.getElementById('ev-plug-value'),
  };
}

describe('EV settings wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2099, 0, 1, 10, 7));
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('sets the departure minimum to the current 15-minute block', () => {
    const els = setupEls();

    initDepartureDatetimeMin(els);

    expect(els.evDepartureTime.min).toBe('2099-01-01T10:00');
  });

  it('quick-sets departure to the end of the current plan', () => {
    const els = setupEls();
    const onInput = vi.fn();
    els.evDepartureTime.addEventListener('input', onInput);

    updateEvDepartureQuickSet(els, [{ timestampMs: new Date(2099, 0, 1, 12, 30).getTime() }]);
    els.evDepartureQuickSet.click();

    expect(els.evDepartureQuickSet.disabled).toBe(false);
    expect(els.evDepartureTime.value).toBe('2099-01-01T12:30');
    expect(onInput).toHaveBeenCalledTimes(1);
  });

  it('refreshes HA sensor values and enables target SoC quick-set', async () => {
    const els = setupEls();
    els.evSocSensor.value = 'sensor.ev_soc';
    els.evPlugSensor.value = 'binary_sensor.ev_plug';
    fetchHaEntityState
      .mockResolvedValueOnce({ state: '72.4' })
      .mockResolvedValueOnce({ state: 'on' });

    await refreshEvSensorStates(els);
    els.evTargetSocQuickSet.click();

    expect(fetchHaEntityState).toHaveBeenCalledWith('sensor.ev_soc');
    expect(fetchHaEntityState).toHaveBeenCalledWith('binary_sensor.ev_plug');
    expect(els.evSocValue.textContent).toBe('Current value: 72.4');
    expect(els.evPlugValue.textContent).toBe('Current value: on');
    expect(els.evTargetSocQuickSet.disabled).toBe(false);
    expect(els.evTargetSoc.value).toBe('72');
  });

  it('flushes settings before validating a sensor on blur', async () => {
    vi.useRealTimers();
    const els = setupEls();
    const persistConfig = vi.fn().mockResolvedValue();
    const persistConfigDebounced = Object.assign(vi.fn(), { cancel: vi.fn() });
    const debounceRun = Object.assign(vi.fn(), { cancel: vi.fn() });
    fetchHaEntityState.mockResolvedValue({ state: '61' });

    wireEvSensorInputs(els, { persistConfig, persistConfigDebounced, debounceRun });
    els.evSocSensor.value = 'sensor.ev_soc';
    els.evSocSensor.dispatchEvent(new Event('blur'));
    await flushPromises();

    expect(persistConfigDebounced.cancel).toHaveBeenCalledTimes(1);
    expect(debounceRun.cancel).toHaveBeenCalledTimes(1);
    expect(persistConfig).toHaveBeenCalledTimes(1);
    expect(fetchHaEntityState).toHaveBeenCalledWith('sensor.ev_soc');
    expect(els.evSocValue.textContent).toBe('Current value: 61');
    expect(els.evSocValue.dataset.haState).toBe('61');

    els.evSocSensor.dispatchEvent(new Event('input'));
    expect(els.evSocValue.textContent).toBe('');
    expect(els.evSocValue.dataset.haState).toBeUndefined();
  });
});
