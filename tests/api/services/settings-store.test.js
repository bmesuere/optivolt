import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const defaultSettings = JSON.parse(
  await readFile(new URL('../../../api/defaults/default-settings.json', import.meta.url), 'utf8'),
);

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'optivolt-store-test-'));
  process.env.DATA_DIR = tmpDir;
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  await rm(tmpDir, { recursive: true, force: true });
});

// The store resolves DATA_DIR at module load; a cache-busting import gets a
// fresh instance per test (same pattern as solver-inputs-version.test.js).
async function importStore() {
  return import('../../../api/services/settings-store.ts?' + Date.now());
}

describe('settings-store validate-on-save', () => {
  it('refuses to write settings with an invalid numeric field', async () => {
    const { saveSettings, SettingsValidationError } = await importStore();

    await expect(saveSettings({ ...defaultSettings, stepSize_m: 'abc' }))
      .rejects.toBeInstanceOf(SettingsValidationError);
    await expect(saveSettings({ ...defaultSettings, batteryCapacity_Wh: NaN }))
      .rejects.toThrow('Invalid numeric setting: batteryCapacity_Wh');

    await expect(readFile(path.join(tmpDir, 'settings.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses out-of-domain values even when they are finite numbers', async () => {
    const { saveSettings, SettingsValidationError } = await importStore();

    await expect(saveSettings({ ...defaultSettings, stepSize_m: 0 }))
      .rejects.toThrow('Invalid setting: stepSize_m must be > 0');
    await expect(saveSettings({ ...defaultSettings, dischargeEfficiency_percent: 0 }))
      .rejects.toThrow('Invalid setting: dischargeEfficiency_percent must be in (0, 100]');
    await expect(saveSettings({ ...defaultSettings, maxDischargePower_W: -100 }))
      .rejects.toThrow('Invalid setting: maxDischargePower_W must be >= 0');
    await expect(saveSettings({ ...defaultSettings, evEnabled: 'yes' }))
      .rejects.toBeInstanceOf(SettingsValidationError);
    await expect(saveSettings({ ...defaultSettings, dataSources: { ...defaultSettings.dataSources, soc: 'vrm' } }))
      .rejects.toThrow('Invalid setting: dataSources.soc must be one of mqtt, api');

    await expect(readFile(path.join(tmpDir, 'settings.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('clamps values before writing, without mutating the caller object', async () => {
    const { saveSettings } = await importStore();
    const input = { ...defaultSettings, minSoc_percent: 150, evSocValue_cents_per_kWh: -5 };

    await saveSettings(input);

    const persisted = JSON.parse(await readFile(path.join(tmpDir, 'settings.json'), 'utf8'));
    expect(persisted.minSoc_percent).toBe(100);
    expect(persisted.evSocValue_cents_per_kWh).toBe(0);
    expect(input.minSoc_percent).toBe(150);
  });
});

describe('settings-store schema versioning', () => {
  it('stamps schemaVersion on save', async () => {
    const { loadSettings, saveSettings, SETTINGS_SCHEMA_VERSION } = await importStore();
    await saveSettings(await loadSettings());

    const written = JSON.parse(await readFile(path.join(tmpDir, 'settings.json'), 'utf8'));
    expect(written.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
  });

  it('preserves a newer on-disk schemaVersion through load and save (downgrade safety)', async () => {
    const { loadSettings, saveSettings, SETTINGS_SCHEMA_VERSION } = await importStore();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({ ...defaultSettings, schemaVersion: SETTINGS_SCHEMA_VERSION + 1 }),
      'utf8',
    );

    const settings = await loadSettings();
    expect(settings.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION + 1);

    await saveSettings(settings);
    const written = JSON.parse(await readFile(path.join(tmpDir, 'settings.json'), 'utf8'));
    expect(written.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION + 1);
  });
});
