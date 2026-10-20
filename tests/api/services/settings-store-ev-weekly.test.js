import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const defaultSettings = JSON.parse(
  await readFile(new URL('../../../api/defaults/default-settings.json', import.meta.url), 'utf8'),
);

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'optivolt-ev-weekly-test-'));
  process.env.DATA_DIR = tmpDir;
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  await rm(tmpDir, { recursive: true, force: true });
});

async function importStore() {
  return import('../../../api/services/settings-store.ts?' + Date.now());
}

describe('settings-store — weekly EV schedule and ESS floor', () => {
  it('defaults to no weekly schedule and a disabled floor', async () => {
    const { loadSettings } = await importStore();
    const settings = await loadSettings();
    expect(settings.evWeeklySchedule).toEqual([]);
    expect(settings.evEssSocFloor_percent).toBe(0);
  });

  it('normalizes a valid schedule and clamps the floor', async () => {
    const { saveSettings } = await importStore();
    await saveSettings({
      ...defaultSettings,
      evWeeklySchedule: [{ weekday: '0', start: '20:00', end: '07:00', soc_percent: '70' }],
      evEssSocFloor_percent: 140,
    });
    const persisted = JSON.parse(await readFile(path.join(tmpDir, 'settings.json'), 'utf8'));
    expect(persisted.evWeeklySchedule).toEqual([{ weekdays: [0], start: '20:00', end: '07:00', soc_percent: 70, ess_soc_percent: 100 }]);
    expect(persisted.evEssSocFloor_percent).toBe(100);
  });

  it('refuses a malformed schedule with a validation error', async () => {
    const { saveSettings, SettingsValidationError } = await importStore();
    let error;
    try {
      await saveSettings({ ...defaultSettings, evWeeklySchedule: [{ weekday: 3, start: '25:00', end: '07:00', soc_percent: 80 }] });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(SettingsValidationError);
    expect(error.message).toContain('evWeeklySchedule[0].start');
  });
});
