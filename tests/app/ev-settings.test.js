// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/src/api/api.js', () => ({
  fetchHaEntityState: vi.fn(),
}));

import { fetchHaEntityState } from '../../app/src/api/api.js';
import {
  refreshEvSensorStates,
  wireEvSensorInputs,
} from '../../app/src/ev-settings.js';

const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0));

function setupEls() {
  document.body.innerHTML = `
    <input id="ev-soc-sensor" />
    <input id="ev-plug-sensor" />
    <span id="ev-soc-value"></span>
    <span id="ev-plug-value"></span>
  `;
  return {
    evSocSensor: document.getElementById('ev-soc-sensor'),
    evPlugSensor: document.getElementById('ev-plug-sensor'),
    evSocValue: document.getElementById('ev-soc-value'),
    evPlugValue: document.getElementById('ev-plug-value'),
  };
}

describe('EV sensor wiring', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('refreshes HA sensor values and stores them on the indicators', async () => {
    const els = setupEls();
    els.evSocSensor.value = 'sensor.ev_soc';
    els.evPlugSensor.value = 'binary_sensor.ev_plug';
    fetchHaEntityState
      .mockResolvedValueOnce({ state: '72.4' })
      .mockResolvedValueOnce({ state: 'on' });

    await refreshEvSensorStates(els);

    expect(fetchHaEntityState).toHaveBeenCalledWith('sensor.ev_soc');
    expect(fetchHaEntityState).toHaveBeenCalledWith('binary_sensor.ev_plug');
    expect(els.evSocValue.textContent).toBe('Current value: 72.4');
    expect(els.evPlugValue.textContent).toBe('Current value: on');
    expect(els.evSocValue.dataset.haState).toBe('72.4');
  });

  it('flushes settings before validating a sensor on blur', async () => {
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
