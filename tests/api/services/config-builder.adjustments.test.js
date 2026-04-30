import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSolverInputs } from '../../../api/services/config-builder.ts';
import { loadData, saveData } from '../../../api/services/data-store.ts';
import { loadSettings } from '../../../api/services/settings-store.ts';

vi.mock('../../../api/services/data-store.ts');
vi.mock('../../../api/services/settings-store.ts');
vi.mock('../../../api/services/ha-client.ts');

const NOW = '2099-01-01T00:05:00.000Z';

const settings = {
  stepSize_m: 15,
  batteryCapacity_Wh: 10000,
  minSoc_percent: 20,
  maxSoc_percent: 90,
  maxChargePower_W: 1000,
  maxDischargePower_W: 1000,
  maxGridImport_W: 2000,
  maxGridExport_W: 2000,
  chargeEfficiency_percent: 95,
  dischargeEfficiency_percent: 95,
  batteryCost_cent_per_kWh: 0,
  idleDrain_W: 0,
  terminalSocValuation: 'zero',
  terminalSocCustomPrice_cents_per_kWh: 0,
  dataSources: { load: 'vrm', pv: 'vrm', prices: 'vrm', soc: 'mqtt' },
  rebalanceEnabled: false,
  rebalanceHoldHours: 3,
  evEnabled: false,
};

describe('getSolverInputs — prediction adjustments', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    vi.clearAllMocks();
    loadSettings.mockResolvedValue(settings);
    saveData.mockResolvedValue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies prediction adjustments to solver inputs without mutating returned raw data', async () => {
    loadData.mockResolvedValue({
      load: { start: '2099-01-01T00:00:00.000Z', step: 15, values: [100, 100, 100, 100] },
      pv: { start: '2099-01-01T00:00:00.000Z', step: 15, values: [200, 200, 200, 200] },
      importPrice: { start: '2099-01-01T00:00:00.000Z', step: 15, values: [10, 10, 10, 10] },
      exportPrice: { start: '2099-01-01T00:00:00.000Z', step: 15, values: [5, 5, 5, 5] },
      soc: { timestamp: '2099-01-01T00:00:00.000Z', value: 50 },
      predictionAdjustments: [
        { id: 'load-add', series: 'load', mode: 'add', value_W: 50, start: '2099-01-01T00:15:00.000Z', end: '2099-01-01T00:45:00.000Z', createdAt: '2099-01-01T00:00:00.000Z', updatedAt: '2099-01-01T00:00:00.000Z' },
        { id: 'pv-off', series: 'pv', mode: 'set', value_W: 0, start: '2099-01-01T00:30:00.000Z', end: '2099-01-01T01:00:00.000Z', createdAt: '2099-01-01T00:00:00.000Z', updatedAt: '2099-01-01T00:00:00.000Z' },
      ],
    });

    const { cfg, data } = await getSolverInputs();

    expect(cfg.load_W).toEqual([100, 150, 150, 100]);
    expect(cfg.pv_W).toEqual([200, 200, 0, 0]);
    expect(data.load.values).toEqual([100, 100, 100, 100]);
    expect(data.pv.values).toEqual([200, 200, 200, 200]);
    expect(saveData).not.toHaveBeenCalled();
  });
});
