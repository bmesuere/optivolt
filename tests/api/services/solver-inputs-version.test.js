import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getSolverInputsVersion } from '../../../api/services/solver-inputs-version.ts';

// saveSettings validates before writing, so the test payload must be a full
// valid Settings object; start from the shipped defaults.
const defaultSettings = JSON.parse(
  await readFile(new URL('../../../api/defaults/default-settings.json', import.meta.url), 'utf8'),
);

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'optivolt-test-'));
  process.env.DATA_DIR = tmpDir;
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  await rm(tmpDir, { recursive: true, force: true });
});

const series = { start: '2024-01-01T00:00:00.000Z', step: 60, values: [1, 2, 3] };
const data = {
  load: series,
  pv: series,
  importPrice: series,
  exportPrice: series,
  soc: { timestamp: '2024-01-01T00:00:00.000Z', value: 50 },
};

// The stores are imported with a cache-busting query so each test gets fresh
// module state (the remembered last-saved JSON); the version module itself is
// imported statically, so it is shared with the fresh store instances.
describe('solver-inputs versioning', () => {
  it('saveData bumps on content changes, not on identical rewrites', async () => {
    const { saveData } = await import('../../../api/services/data-store.ts?' + Date.now());

    const before = getSolverInputsVersion();
    await saveData(data);
    expect(getSolverInputsVersion()).toBe(before + 1);

    // Byte-identical rewrite — what the boot forecast run often produces.
    await saveData({ ...data });
    expect(getSolverInputsVersion()).toBe(before + 1);

    await saveData({ ...data, soc: { ...data.soc, value: 55 } });
    expect(getSolverInputsVersion()).toBe(before + 2);
  });

  it('saveSettings bumps on content changes, not on identical rewrites', async () => {
    const { saveSettings } = await import('../../../api/services/settings-store.ts?' + Date.now());
    const settings = { ...defaultSettings, stepSize_m: 15, batteryCapacity_Wh: 10000 };

    const before = getSolverInputsVersion();
    await saveSettings(settings);
    expect(getSolverInputsVersion()).toBe(before + 1);

    await saveSettings({ ...settings });
    expect(getSolverInputsVersion()).toBe(before + 1);

    await saveSettings({ ...settings, stepSize_m: 60 });
    expect(getSolverInputsVersion()).toBe(before + 2);
  });
});
