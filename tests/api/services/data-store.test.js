import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../api/services/json-store.ts', () => ({
  resolveDataDir: () => '/tmp/optivolt-test-data',
  readJson: vi.fn(),
  writeJson: vi.fn(),
}));

import { writeJson } from '../../../api/services/json-store.ts';
import { saveData } from '../../../api/services/data-store.ts';

const baseData = {
  load: { start: '2024-01-01T00:00:00.000Z', step: 15, values: [100] },
  pv: { start: '2024-01-01T00:00:00.000Z', step: 15, values: [0] },
  importPrice: { start: '2024-01-01T00:00:00.000Z', step: 15, values: [10] },
  exportPrice: { start: '2024-01-01T00:00:00.000Z', step: 15, values: [5] },
  soc: { timestamp: '2024-01-01T00:00:00.000Z', value: 50 },
};

describe('saveData — centralized full-SoC observation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records lastFullSocAt when the saved soc is 100%', async () => {
    await saveData({ ...baseData, soc: { timestamp: '2024-02-01T12:00:00.000Z', value: 100 } });

    expect(writeJson).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      lastFullSocAt: '2024-02-01T12:00:00.000Z',
    }));
  });

  it('persists data unchanged when soc is below 100%', async () => {
    await saveData({ ...baseData, lastFullSocAt: '2024-01-10T00:00:00.000Z' });

    expect(writeJson).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      soc: baseData.soc,
      lastFullSocAt: '2024-01-10T00:00:00.000Z',
    }));
  });

  it('never moves lastFullSocAt backwards', async () => {
    await saveData({
      ...baseData,
      soc: { timestamp: '2024-01-05T00:00:00.000Z', value: 100 },
      lastFullSocAt: '2024-01-20T00:00:00.000Z',
    });

    expect(writeJson).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      lastFullSocAt: '2024-01-20T00:00:00.000Z',
    }));
  });
});
