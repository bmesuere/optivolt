import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchArchiveIrradiance,
  fetchForecastIrradiance,
} from '../../../api/services/open-meteo-client.ts';

describe('Open-Meteo HTTP client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('applies a deadline to archive requests', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ hourly: { time: [], shortwave_radiation: [] } }),
    });

    await fetchArchiveIrradiance(51, 4, '2026-01-01', '2026-01-02', 1234);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('archive-api.open-meteo.com'),
      { signal: expect.any(AbortSignal) },
    );
  });

  it('reports forecast timeouts with operation context', async () => {
    global.fetch.mockImplementation((_input, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));

    await expect(
      fetchForecastIrradiance(51, 4, undefined, 60, 2, 5),
    ).rejects.toThrow('Open-Meteo Forecast API request timed out after 5ms');
  });
});
