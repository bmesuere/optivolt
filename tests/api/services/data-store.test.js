import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../api/services/json-store.ts', () => ({
  resolveDataDir: () => '/tmp/optivolt-test-data',
  readJson: vi.fn(),
  writeJson: vi.fn(),
}));

import { readJson, writeJson } from '../../../api/services/json-store.ts';
import { saveData, loadData, DATA_SCHEMA_VERSION } from '../../../api/services/data-store.ts';

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

describe('data.json schema versioning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const serveFiles = (stored) => {
    readJson.mockImplementation(async (p) => {
      if (p.includes('default-data')) return structuredClone(baseData);
      if (stored === undefined) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return structuredClone(stored);
    });
  };

  it('stamps schemaVersion on save', async () => {
    await saveData({ ...baseData });

    expect(writeJson).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      schemaVersion: DATA_SCHEMA_VERSION,
    }));
  });

  it('fills missing keys from defaults instead of throwing (pre-versioning file)', async () => {
    // A stored file from before a new required field shipped: no soc, no version.
    const { soc: _soc, ...withoutSoc } = baseData;
    serveFiles(withoutSoc);

    const data = await loadData();

    expect(data.soc).toEqual(baseData.soc);
    expect(data.schemaVersion).toBe(DATA_SCHEMA_VERSION);
  });

  it('keeps stored values over defaults when both exist', async () => {
    serveFiles({ ...baseData, soc: { timestamp: '2024-06-01T00:00:00.000Z', value: 81 } });

    const data = await loadData();

    expect(data.soc.value).toBe(81);
  });

  it('stamps schemaVersion on the defaults fallback when no file exists', async () => {
    serveFiles(undefined);

    const data = await loadData();

    expect(data.schemaVersion).toBe(DATA_SCHEMA_VERSION);
  });

  it('preserves a newer on-disk schemaVersion through load and save (downgrade safety)', async () => {
    // A file written by a newer build must keep its marker, or upgrading back
    // would re-run that version's migration on already-migrated state.
    serveFiles({ ...baseData, schemaVersion: DATA_SCHEMA_VERSION + 1 });

    const data = await loadData();
    expect(data.schemaVersion).toBe(DATA_SCHEMA_VERSION + 1);

    await saveData(data);
    expect(writeJson).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      schemaVersion: DATA_SCHEMA_VERSION + 1,
    }));
  });
});
