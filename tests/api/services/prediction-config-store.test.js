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

    it('defaults missing pvModel to clearSkyRatio', async () => {
      await writeFile(
        path.join(tmpDir, 'prediction-config.json'),
        JSON.stringify({
          sensors: [],
          derived: [],
          pvConfig: {
            latitude: 51.1,
            longitude: 3.7,
            historyDays: 7,
            pvSensor: 'Solar Generation',
            pvMode: '15min',
          },
        }),
        'utf8',
      );

      const { loadPredictionConfig } = await importStore();
      const config = await loadPredictionConfig();

      expect(config.pvConfig.pvModel).toBe('clearSkyRatio');
      expect(config.pvConfig.pvMode).toBe('15min');
    });
  });

  describe('migration: activeConfig → predictors', () => {
    it('migrates old activeConfig format through to a predictors list', async () => {
      await writeFile(
        path.join(tmpDir, 'prediction-config.json'),
        JSON.stringify({
          sensors: [{ id: 'sensor.grid', name: 'Grid Import', unit: 'kWh' }],
          derived: [],
          activeConfig: {
            sensor: 'Total Load',
            lookbackWeeks: 4,
            dayFilter: 'weekday-weekend',
            aggregation: 'mean',
          },
        }),
        'utf8',
      );

      const { loadPredictionConfig } = await importStore();
      const config = await loadPredictionConfig();

      expect(config.predictors).toEqual([{
        type: 'historical',
        sensor: 'Total Load',
        lookbackWeeks: 4,
        dayFilter: 'weekday-weekend',
        aggregation: 'mean',
      }]);
      expect(config).not.toHaveProperty('activeConfig');
      expect(config).not.toHaveProperty('activeType');
      expect(config).not.toHaveProperty('historicalPredictor');
    });
  });

  describe('migration: v1 single active predictor → predictors', () => {
    it('folds an active historical predictor into the predictors list', async () => {
      await writeFile(
        path.join(tmpDir, 'prediction-config.json'),
        JSON.stringify({
          schemaVersion: 1,
          sensors: [],
          derived: [],
          activeType: 'historical',
          historicalPredictor: { sensor: 'Total Load', lookbackWeeks: 3, dayFilter: 'same', aggregation: 'median' },
          fixedPredictor: { load_W: 200 },
        }),
        'utf8',
      );

      const { loadPredictionConfig } = await importStore();
      const config = await loadPredictionConfig();

      expect(config.predictors).toEqual([{
        type: 'historical',
        sensor: 'Total Load',
        lookbackWeeks: 3,
        dayFilter: 'same',
        aggregation: 'median',
      }]);
      expect(config).not.toHaveProperty('activeType');
      expect(config).not.toHaveProperty('historicalPredictor');
      expect(config).not.toHaveProperty('fixedPredictor');
    });

    it('folds an active fixed predictor into the predictors list', async () => {
      await writeFile(
        path.join(tmpDir, 'prediction-config.json'),
        JSON.stringify({
          schemaVersion: 1,
          sensors: [],
          derived: [],
          activeType: 'fixed',
          historicalPredictor: { sensor: 'Total Load', lookbackWeeks: 3, dayFilter: 'same', aggregation: 'median' },
          fixedPredictor: { load_W: 420 },
        }),
        'utf8',
      );

      const { loadPredictionConfig } = await importStore();
      const config = await loadPredictionConfig();

      expect(config.predictors).toEqual([{ type: 'fixed', load_W: 420 }]);
    });

    it('leaves an existing predictors list untouched and strips stray v1 keys', async () => {
      await writeFile(
        path.join(tmpDir, 'prediction-config.json'),
        JSON.stringify({
          schemaVersion: 2,
          sensors: [],
          derived: [],
          predictors: [{ type: 'fixed', load_W: 100 }],
          activeType: 'historical',
          historicalPredictor: { sensor: 'Total Load', lookbackWeeks: 3, dayFilter: 'same', aggregation: 'median' },
        }),
        'utf8',
      );

      const { loadPredictionConfig } = await importStore();
      const config = await loadPredictionConfig();

      expect(config.predictors).toEqual([{ type: 'fixed', load_W: 100 }]);
      expect(config).not.toHaveProperty('activeType');
      expect(config).not.toHaveProperty('historicalPredictor');
    });
  });

  describe('schema versioning', () => {
    it('stamps schemaVersion on save and returns it on load', async () => {
      const { loadPredictionConfig, savePredictionConfig, PREDICTION_CONFIG_SCHEMA_VERSION } = await importStore();

      const config = await loadPredictionConfig();
      expect(config.schemaVersion).toBe(PREDICTION_CONFIG_SCHEMA_VERSION);

      await savePredictionConfig(config);
      const reloaded = await loadPredictionConfig();
      expect(reloaded.schemaVersion).toBe(PREDICTION_CONFIG_SCHEMA_VERSION);
    });

    it('preserves a newer on-disk schemaVersion through load and save (downgrade safety)', async () => {
      const { loadPredictionConfig, savePredictionConfig, PREDICTION_CONFIG_SCHEMA_VERSION } = await importStore();
      await writeFile(
        path.join(tmpDir, 'prediction-config.json'),
        JSON.stringify({ sensors: [], derived: [], schemaVersion: PREDICTION_CONFIG_SCHEMA_VERSION + 1 }),
        'utf8',
      );

      const config = await loadPredictionConfig();
      expect(config.schemaVersion).toBe(PREDICTION_CONFIG_SCHEMA_VERSION + 1);

      await savePredictionConfig(config);
      const reloaded = await loadPredictionConfig();
      expect(reloaded.schemaVersion).toBe(PREDICTION_CONFIG_SCHEMA_VERSION + 1);
    });

    it('still migrates a pre-versioning activeConfig file', async () => {
      await writeFile(
        path.join(tmpDir, 'prediction-config.json'),
        JSON.stringify({
          activeConfig: { sensor: 'sensor.load', lookbackWeeks: 3, dayFilter: 'all', aggregation: 'mean' },
        }),
        'utf8',
      );

      const { loadPredictionConfig } = await importStore();
      const config = await loadPredictionConfig();

      expect(config.predictors).toEqual([
        expect.objectContaining({ type: 'historical', sensor: 'sensor.load', lookbackWeeks: 3 }),
      ]);
      expect(config.activeConfig).toBeUndefined();
    });
  });
});
