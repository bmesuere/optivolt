import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../api/app.ts';

vi.mock('../../api/services/settings-store.ts');
vi.mock('../../api/services/prediction-forecast-runner.ts');

import { loadSettings, saveSettings, loadDefaultSettings } from '../../api/services/settings-store.ts';
import {
  buildPredictionRunConfig,
  runCombinedPredictionForecast,
} from '../../api/services/prediction-forecast-runner.ts';

const settingsWith = (extendedHorizonDays, dataSources = { load: 'api', pv: 'api', prices: 'vrm', soc: 'mqtt' }) => ({
  stepSize_m: 15,
  extendedHorizonDays,
  dataSources,
});

/** loadSettings is called twice per POST: before the write, and after it to read back the normalized value. */
const mockLoadSequence = (before, after) => {
  loadSettings.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
};

describe('POST /settings — forecast refresh on horizon change', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveSettings.mockResolvedValue(undefined);
    // The route whitelists incoming keys against the defaults shape.
    loadDefaultSettings.mockResolvedValue(settingsWith(0));
    buildPredictionRunConfig.mockResolvedValue({ sensors: [] });
    runCombinedPredictionForecast.mockResolvedValue({ load: null, pv: null });
  });

  it('regenerates the load/PV forecasts when the horizon changes', async () => {
    mockLoadSequence(settingsWith(1), settingsWith(3));

    const res = await request(app).post('/settings').send({ extendedHorizonDays: 3 });

    expect(res.status).toBe(200);
    expect(runCombinedPredictionForecast).toHaveBeenCalledTimes(1);
    // Reported so the client can re-read the series its Predictions tab caches.
    expect(res.body.forecastsRefreshed).toBe(true);
  });

  it('does not regenerate when the horizon is unchanged', async () => {
    mockLoadSequence(settingsWith(2), settingsWith(2));

    const res = await request(app).post('/settings').send({ maxSoc_percent: 90 });

    expect(res.status).toBe(200);
    expect(runCombinedPredictionForecast).not.toHaveBeenCalled();
    expect(res.body.forecastsRefreshed).toBe(false);
  });

  it('does not regenerate when neither load nor PV is api-sourced', async () => {
    const vrmSources = { load: 'vrm', pv: 'vrm', prices: 'vrm', soc: 'mqtt' };
    mockLoadSequence(settingsWith(1, vrmSources), settingsWith(3, vrmSources));

    const res = await request(app).post('/settings').send({ extendedHorizonDays: 3 });

    expect(res.status).toBe(200);
    expect(runCombinedPredictionForecast).not.toHaveBeenCalled();
  });

  it('still saves the settings when the forecast refresh fails', async () => {
    mockLoadSequence(settingsWith(0), settingsWith(2));
    runCombinedPredictionForecast.mockRejectedValue(new Error('HA unreachable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await request(app).post('/settings').send({ extendedHorizonDays: 2 });

    expect(res.status).toBe(200);
    expect(saveSettings).toHaveBeenCalled();
    // Nothing was regenerated, so the client must not drop its cache.
    expect(res.body.forecastsRefreshed).toBe(false);
    warn.mockRestore();
  });
});
