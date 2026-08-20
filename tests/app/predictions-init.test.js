// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/src/api/api.js', () => ({
  fetchStoredData: vi.fn().mockResolvedValue({}),
  runCombinedForecast: vi.fn(),
  runPvForecast: vi.fn(),
}));

vi.mock('../../app/src/predictions/config-form.js', () => ({
  hydratePredictionForm: vi.fn().mockResolvedValue(undefined),
  savePredictionFormToServer: vi.fn().mockResolvedValue(undefined),
  wirePredictionForm: vi.fn(),
}));

vi.mock('../../app/src/predictions/accuracy-charts.js', () => ({
  renderLoadAccuracyChart: vi.fn(),
  renderPvAccuracyChart: vi.fn(),
}));

vi.mock('../../app/src/predictions/forecast-chart.js', () => ({
  createForecastChartController: () => ({
    getAdjustments: () => [],
    loadAdjustments: vi.fn().mockResolvedValue(undefined),
    render: vi.fn(),
    wireAdjustmentPopover: vi.fn(),
  }),
}));

import { fetchStoredData, runCombinedForecast } from '../../app/src/api/api.js';
import { hydratePredictionForm, savePredictionFormToServer } from '../../app/src/predictions/config-form.js';
import { initPredictionsTab } from '../../app/src/predictions.js';

afterEach(() => {
  vi.clearAllMocks();
});

describe('predictions tab boot', () => {
  it('reads stored state only — no config write, no forecast compute', async () => {
    await initPredictionsTab();

    expect(hydratePredictionForm).toHaveBeenCalledTimes(1);
    expect(fetchStoredData).toHaveBeenCalledTimes(1);
    // Page load must not write the config back nor kick off a forecast run;
    // both are reserved for an explicit user action.
    expect(savePredictionFormToServer).not.toHaveBeenCalled();
    expect(runCombinedForecast).not.toHaveBeenCalled();
  });
});
