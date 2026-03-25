import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'optivolt-test-'));
  process.env.DATA_DIR = tmpDir;
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  await rm(tmpDir, { recursive: true, force: true });
});

async function importStore() {
  // Fresh import each test so DATA_DIR is picked up
  return import('../../../api/services/prediction-config-store.ts?' + Date.now());
}

describe('prediction-config-store', () => {
  describe('loadPredictionConfig', () => {
    it('always recomputes validationWindow, ignoring any persisted value', async () => {
      await writeFile(
        path.join(tmpDir, 'prediction-config.json'),
        JSON.stringify({
          sensors: [],
          derived: [],
          validationWindow: { start: '2026-01-18T00:00:00Z', end: '2026-01-25T00:00:00Z' },
        }),
        'utf8',
      );

      const { loadPredictionConfig } = await importStore();
      const config = await loadPredictionConfig();

      const now = new Date();
      const expectedEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const expectedStart = new Date(expectedEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

      expect(config.validationWindow.start).toBe(expectedStart.toISOString());
      expect(config.validationWindow.end).toBe(expectedEnd.toISOString());
    });

    it('returns a computed validationWindow when none is persisted', async () => {
      const { loadPredictionConfig } = await importStore();
      const config = await loadPredictionConfig();

      const now = new Date();
      const expectedEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const expectedStart = new Date(expectedEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

      expect(config.validationWindow.start).toBe(expectedStart.toISOString());
      expect(config.validationWindow.end).toBe(expectedEnd.toISOString());
    });
  });
});
