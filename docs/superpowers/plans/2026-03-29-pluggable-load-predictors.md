# Pluggable Load Predictors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single historical load predictor with a pluggable system supporting `historical` and `fixed` predictor types, switchable without losing sub-config settings.

**Architecture:** `PredictionConfig` gains `activeType`, `historicalPredictor?`, and `fixedPredictor?` fields. The config store migrates old `activeConfig` format on read. `runForecast` branches on `activeType`. The UI always renders both sub-configs so settings survive a type switch.

**Tech Stack:** TypeScript (Node 24, type-stripping), Express 5, Vitest

---

## File map

| File | Change |
|------|--------|
| `lib/predict-load.ts` | **Renamed** → `lib/load-predictor-historical.ts` |
| `api/types.ts` | Add `LoadPredictor` union; update `PredictionConfig` |
| `api/services/prediction-config-store.ts` | Add migration for old `activeConfig` format |
| `api/services/load-prediction-service.ts` | Branch on `activeType`; use `historicalPredictor` |
| `api/routes/predictions.ts` | Update `assertCondition` + log |
| `api/defaults/default-prediction-config.json` | Update to new config shape |
| `tests/lib/predict-load.test.js` | **Renamed** → `tests/lib/load-predictor-historical.test.js` |
| `tests/api/predictions.test.js` | Update mock fixtures and assertions |
| `tests/api/services/prediction-config-store.test.js` | Add migration test |
| `tests/api/services/load-prediction-service.test.js` | **New** — fixed forecast test |
| `app/index.html` | Add predictor type select + fixed load W input |
| `app/src/predictions.js` | Update form read/write/render |
| `app/src/predictions-validation.js` | Rename `renderLoadConfig` → `renderHistoricalConfig` |

---

### Task 1: Rename predict-load.ts and update all its imports

**Files:**
- Rename: `lib/predict-load.ts` → `lib/load-predictor-historical.ts`
- Modify: `api/types.ts` (import path only)
- Modify: `api/services/load-prediction-service.ts` (import path only)
- Rename: `tests/lib/predict-load.test.js` → `tests/lib/load-predictor-historical.test.js`

- [ ] **Step 1: Rename the lib file and the test file**

```bash
git mv lib/predict-load.ts lib/load-predictor-historical.ts
git mv tests/lib/predict-load.test.js tests/lib/load-predictor-historical.test.js
```

- [ ] **Step 2: Update the comment inside the renamed lib file**

In `lib/load-predictor-historical.ts`, change line 2:
```
 * predict-load.ts
```
to:
```
 * load-predictor-historical.ts
```

- [ ] **Step 3: Update the import in api/types.ts**

Change line 2 of `api/types.ts`:
```ts
import type { DayFilter, Aggregation } from '../lib/predict-load.ts';
```
to:
```ts
import type { DayFilter, Aggregation } from '../lib/load-predictor-historical.ts';
```

- [ ] **Step 4: Update the imports in api/services/load-prediction-service.ts**

Change lines 14–15:
```ts
} from '../../lib/predict-load.ts';
import type { DayFilter, Aggregation } from '../../lib/predict-load.ts';
```
to:
```ts
} from '../../lib/load-predictor-historical.ts';
import type { DayFilter, Aggregation } from '../../lib/load-predictor-historical.ts';
```

- [ ] **Step 5: Update the import in tests/lib/load-predictor-historical.test.js**

Change line 9:
```js
} from '../../lib/predict-load.ts';
```
to:
```js
} from '../../lib/load-predictor-historical.ts';
```

- [ ] **Step 6: Run tests to verify nothing broke**

```bash
npx vitest run tests/lib/load-predictor-historical.test.js
```

Expected: all tests pass (same as before rename).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: rename predict-load.ts to load-predictor-historical.ts"
```

---

### Task 2: Update types, service, route, and API test fixtures

This task updates all type-driven code together so the repo compiles cleanly after it. No new behavior yet — the fixed branch throws `'not implemented'`.

**Files:**
- Modify: `api/types.ts`
- Modify: `api/services/load-prediction-service.ts`
- Modify: `api/routes/predictions.ts`
- Modify: `tests/api/predictions.test.js`

- [ ] **Step 1: Update api/types.ts**

Replace the `PredictionActiveConfig` interface and its use in `PredictionConfig`. The full updated block (lines 83–115) becomes:

```ts
export type LoadPredictor =
  | { type: 'historical'; sensor: string; lookbackWeeks: number; dayFilter: DayFilter; aggregation: Aggregation }
  | { type: 'fixed'; load_W: number };

export interface PredictionConfig {
  sensors: HaSensor[];
  derived: HaDerivedSensor[];
  activeType: 'historical' | 'fixed';
  historicalPredictor?: { sensor: string; lookbackWeeks: number; dayFilter: DayFilter; aggregation: Aggregation };
  fixedPredictor?: { load_W: number };
  validationWindow?: PredictionValidationWindow;
  includeRecent?: boolean;
  pvConfig?: PvPredictionConfig;
}

/** PredictionConfig enriched with HA credentials from Settings, passed to prediction services. */
export interface PredictionRunConfig extends PredictionConfig {
  haUrl: string;
  haToken: string;
}
```

Delete `PredictionActiveConfig` entirely (it is not imported anywhere else).

- [ ] **Step 2: Update api/services/load-prediction-service.ts**

Replace the body of `runForecast` so it uses `historicalPredictor` instead of `activeConfig`, and adds a stub for the fixed branch. The full updated function:

```ts
export async function runForecast(config: PredictionRunConfig): Promise<ForecastRunResult> {
  const { activeType, historicalPredictor, haUrl, haToken, sensors, derived } = config;

  if (activeType !== 'historical') {
    throw new Error(`Unsupported predictor type: ${activeType}`);
  }

  const entityIds = sensors.map(s => s.id);

  // historicalPredictor is guaranteed by the route's assertCondition check
  const extraWeeks = config.includeRecent !== false ? 1 : 0;
  const totalWeeks = historicalPredictor!.lookbackWeeks + extraWeeks;
  const startTime = new Date(Date.now() - totalWeeks * 7 * 24 * 60 * 60 * 1000).toISOString();

  const rawData = await fetchHaStats({
    haUrl,
    haToken,
    entityIds,
    startTime,
  });

  const data = postprocess(rawData, sensors, derived);

  const now = new Date();
  const { startIso, endIso } = getForecastTimeRange(now.getTime());
  const end = new Date(endIso);

  const recentStart = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const recentEnd = now.getTime();

  const recentTargets = data.filter(d =>
    d.sensor === historicalPredictor!.sensor &&
    d.time >= recentStart &&
    d.time <= recentEnd
  );

  const futureTargets: PredictTarget[] = [];
  const futureStart = Math.floor(now.getTime() / 3600000) * 3600000;
  const futureEnd = end.getTime();

  for (let t = futureStart; t < futureEnd; t += 3600000) {
    const d = new Date(t);
    futureTargets.push({
      date: d.toISOString(),
      time: t,
      hour: d.getHours(),
      dayOfWeek: d.getDay(),
      value: null,
    });
  }

  const allTargets: PredictTarget[] = [...recentTargets, ...futureTargets];
  const predictions = predict(data, historicalPredictor!, allTargets);

  const mappedPoints = predictions.map(p => ({ time: p.time, value: p.predicted ?? 0 }));
  const forecastSeries = buildForecastSeries(mappedPoints, startIso, endIso);

  let recent: PredictionResult[] = [];
  if (config.includeRecent !== false) {
    const past7d = Date.now() - 7 * 24 * 60 * 60 * 1000;

    recent = predictions
      .filter(p => p.time <= Date.now() && p.time >= past7d)
      .map(p => ({
        date: p.date,
        time: p.time,
        hour: p.hour,
        actual: p.actual,
        predicted: p.predicted,
      }));
  }

  const metrics = computeErrorMetrics(recent, r => r.actual, r => r.predicted);

  return { forecast: forecastSeries, recent, metrics };
}
```

- [ ] **Step 3: Update the assertCondition in api/routes/predictions.ts**

In `executeLoadForecast`, replace lines 147–150:
```ts
  assertCondition(config.activeConfig != null, 400, 'activeConfig is required');

  logPredictionCall(logLabel + ' (load)', { activeConfig: config.activeConfig });
```
with:
```ts
  assertCondition(config.activeType != null, 400, 'activeType is required');

  logPredictionCall(logLabel + ' (load)', { activeType: config.activeType });
```

- [ ] **Step 4: Update tests/api/predictions.test.js**

Update `mockConfig` and all references to `activeConfig`:

```js
const mockConfig = {
  sensors: [{ id: 'sensor.grid', name: 'Grid Import', unit: 'kWh' }],
  derived: [],
  activeType: 'historical',
  historicalPredictor: { sensor: 'Grid Import', lookbackWeeks: 4, dayFilter: 'weekday-weekend', aggregation: 'mean' },
};
```

In `'merges and saves config'` test (around line 51–58), change the `.send()` body and assertion:
```js
    const res = await request(app)
      .post('/predictions/config')
      .send({ historicalPredictor: { sensor: 'Total Load', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean' } });

    expect(res.status).toBe(200);
    expect(res.body.config.historicalPredictor.sensor).toBe('Total Load');
    expect(savePredictionConfig).toHaveBeenCalled();
```

In `'returns load=null when activeConfig missing (graceful fallback)'` test (line 146–151), change:
```js
    loadPredictionConfig.mockResolvedValue({ ...mockConfig, activeConfig: null });
```
to:
```js
    loadPredictionConfig.mockResolvedValue({ ...mockConfig, activeType: undefined });
```

In `'returns 400 when activeConfig missing'` test (line 182–186), change:
```js
    loadPredictionConfig.mockResolvedValue({ ...mockConfig, activeConfig: null });
```
to:
```js
    loadPredictionConfig.mockResolvedValue({ ...mockConfig, activeType: undefined });
```

- [ ] **Step 5: Run typecheck and all tests**

```bash
npm run typecheck && npx vitest run
```

Expected: typecheck passes, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add api/types.ts api/services/load-prediction-service.ts api/routes/predictions.ts tests/api/predictions.test.js
git commit -m "refactor: replace activeConfig with LoadPredictor type system"
```

---

### Task 3: Write failing migration test

**Files:**
- Modify: `tests/api/services/prediction-config-store.test.js`

- [ ] **Step 1: Add the migration test**

Append to `tests/api/services/prediction-config-store.test.js`, inside the existing `describe('prediction-config-store', ...)` block:

```js
  describe('migration: activeConfig → historicalPredictor', () => {
    it('migrates old activeConfig format to historicalPredictor + activeType', async () => {
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

      expect(config.activeType).toBe('historical');
      expect(config.historicalPredictor).toEqual({
        sensor: 'Total Load',
        lookbackWeeks: 4,
        dayFilter: 'weekday-weekend',
        aggregation: 'mean',
      });
      expect(config).not.toHaveProperty('activeConfig');
    });
  });
```

- [ ] **Step 2: Run to confirm it fails**

```bash
npx vitest run tests/api/services/prediction-config-store.test.js
```

Expected: the new test FAILS (migration not yet implemented).

---

### Task 4: Implement migration in prediction-config-store.ts

**Files:**
- Modify: `api/services/prediction-config-store.ts`

- [ ] **Step 1: Update loadPredictionConfig to migrate old format**

Replace the entire `loadPredictionConfig` function:

```ts
export async function loadPredictionConfig(): Promise<PredictionConfig> {
  const defaults = await readJson<PredictionConfig>(DEFAULT_PATH);
  let userConfig: Record<string, unknown> = {};
  try {
    userConfig = await readJson<Record<string, unknown>>(PREDICTION_CONFIG_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  // Migrate old activeConfig format to historicalPredictor + activeType
  if ('activeConfig' in userConfig && !('historicalPredictor' in userConfig)) {
    const old = userConfig.activeConfig as {
      sensor: string;
      lookbackWeeks: number;
      dayFilter: string;
      aggregation: string;
    };
    const { activeConfig: _ac, ...rest } = userConfig;
    userConfig = {
      ...rest,
      activeType: 'historical',
      historicalPredictor: {
        sensor: old.sensor,
        lookbackWeeks: old.lookbackWeeks,
        dayFilter: old.dayFilter,
        aggregation: old.aggregation,
      },
    };
  }

  const { validationWindow: _vw, ...rest } = { ...defaults, ...(userConfig as Partial<PredictionConfig>) };

  // Always recompute validationWindow — never trust a persisted value
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);

  return {
    ...rest,
    validationWindow: { start: start.toISOString(), end: end.toISOString() },
  };
}
```

- [ ] **Step 2: Run tests to confirm migration test passes**

```bash
npx vitest run tests/api/services/prediction-config-store.test.js
```

Expected: all tests pass including the new migration test.

- [ ] **Step 3: Commit**

```bash
git add api/services/prediction-config-store.ts tests/api/services/prediction-config-store.test.js
git commit -m "feat: migrate old activeConfig format to historicalPredictor on load"
```

---

### Task 5: Write failing fixed forecast test

**Files:**
- Create: `tests/api/services/load-prediction-service.test.js`

- [ ] **Step 1: Create the test file**

```js
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { runForecast } from '../../../api/services/load-prediction-service.ts';

describe('runForecast (fixed predictor)', () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T22:00:00.000Z'));
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it('returns a flat ForecastSeries with all values equal to load_W', async () => {
    const config = {
      activeType: 'fixed',
      fixedPredictor: { load_W: 300 },
      historicalPredictor: undefined,
      sensors: [],
      derived: [],
      haUrl: '',
      haToken: '',
    };

    const result = await runForecast(config);

    expect(result.forecast.step).toBe(15);
    expect(result.forecast.values.length).toBeGreaterThan(0);
    expect(result.forecast.values.every(v => v === 300)).toBe(true);
    expect(result.recent).toHaveLength(0);
    expect(Number.isNaN(result.metrics.mae)).toBe(true);
    expect(result.metrics.n).toBe(0);
  });

  it('uses the fixed load_W value verbatim', async () => {
    const config = {
      activeType: 'fixed',
      fixedPredictor: { load_W: 50 },
      historicalPredictor: undefined,
      sensors: [],
      derived: [],
      haUrl: '',
      haToken: '',
    };

    const result = await runForecast(config);
    expect(result.forecast.values.every(v => v === 50)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
npx vitest run tests/api/services/load-prediction-service.test.js
```

Expected: both tests FAIL (`Unsupported predictor type: fixed`).

---

### Task 6: Implement the fixed forecast branch

**Files:**
- Modify: `api/services/load-prediction-service.ts`

- [ ] **Step 1: Replace the unsupported-type throw with the fixed branch**

At the top of `runForecast`, replace:
```ts
  if (activeType !== 'historical') {
    throw new Error(`Unsupported predictor type: ${activeType}`);
  }
```
with:
```ts
  if (activeType === 'fixed') {
    const load_W = fixedPredictor!.load_W;
    const { startIso, endIso } = getForecastTimeRange();
    const startMs = new Date(startIso).getTime();
    const endMs = new Date(endIso).getTime();
    const nSlots = Math.round((endMs - startMs) / (15 * 60 * 1000));
    const forecast: ForecastSeries = { start: startIso, step: 15, values: Array(nSlots).fill(load_W) };
    return { forecast, recent: [], metrics: { mae: NaN, rmse: NaN, mape: NaN, n: 0 } };
  }
```

Also add `fixedPredictor` to the destructuring at the top of `runForecast`:
```ts
  const { activeType, historicalPredictor, fixedPredictor, haUrl, haToken, sensors, derived } = config;
```

- [ ] **Step 2: Run tests to confirm they pass**

```bash
npx vitest run tests/api/services/load-prediction-service.test.js
```

Expected: both tests PASS.

- [ ] **Step 3: Run full test suite**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add api/services/load-prediction-service.ts tests/api/services/load-prediction-service.test.js
git commit -m "feat: implement fixed load predictor in runForecast"
```

---

### Task 7: Update default prediction config JSON

**Files:**
- Modify: `api/defaults/default-prediction-config.json`

- [ ] **Step 1: Update the file to the new config shape**

```json
{
  "sensors": [
    { "id": "sensor.battery_charged", "name": "Battery Charge", "unit": "kWh" },
    { "id": "sensor.battery_discharged", "name": "Battery Discharge", "unit": "kWh" },
    { "id": "sensor.dsmr_reading_electricity_delivered_1", "name": "Grid Import", "unit": "kWh" },
    { "id": "sensor.dsmr_reading_electricity_delivered_2", "name": "Grid Import", "unit": "kWh" },
    { "id": "sensor.dsmr_reading_electricity_returned_1", "name": "Grid Export", "unit": "kWh" },
    { "id": "sensor.dsmr_reading_electricity_returned_2", "name": "Grid Export", "unit": "kWh" },
    { "id": "sensor.sma_energy", "name": "Solar Generation", "unit": "Wh" },
    { "id": "sensor.solis_energy", "name": "Solar Generation", "unit": "Wh" },
    { "id": "sensor.wallbox_energy", "name": "Wallbox Energy", "unit": "Wh" },
    { "id": "sensor.altherma_outdoor_energy", "name": "Heat Pump Energy", "unit": "Wh" }
  ],
  "derived": [
    {
      "name": "Total Load",
      "formula": ["+Solar Generation", "+Grid Import", "+Battery Discharge", "-Grid Export", "-Battery Charge"]
    },
    {
      "name": "Residual Load",
      "formula": ["+Total Load", "-Wallbox Energy", "-Heat Pump Energy"]
    },
    {
      "name": "Load without EV",
      "formula": ["+Total Load", "-Wallbox Energy"]
    }
  ],
  "activeType": "historical",
  "historicalPredictor": {
    "sensor": "Total Load",
    "lookbackWeeks": 4,
    "dayFilter": "weekday-weekend",
    "aggregation": "mean"
  },
  "fixedPredictor": {
    "load_W": 200
  },
  "pvConfig": {
    "latitude": 51.05,
    "longitude": 3.71,
    "historyDays": 14,
    "pvSensor": "Solar Generation"
  }
}
```

- [ ] **Step 2: Run full test suite**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add api/defaults/default-prediction-config.json
git commit -m "chore: update default prediction config to new LoadPredictor shape"
```

---

### Task 8: Update the UI

**Files:**
- Modify: `app/index.html`
- Modify: `app/src/predictions.js`
- Modify: `app/src/predictions-validation.js`

- [ ] **Step 1: Add predictor type selector and fixed load input to app/index.html**

In the Load Forecast section (around line 778, inside the `<div class="space-y-3">`), add a new block at the very top, before the Sensor label:

```html
          <label class="block text-sm">
            <span class="block text-xs font-medium text-slate-400 dark:text-slate-500 mb-1 tracking-wide">Predictor Type</span>
            <select id="pred-active-type" class="form-select" data-predictions-only="true">
              <option value="historical">Historical</option>
              <option value="fixed">Fixed</option>
            </select>
          </label>

          <label class="block text-sm" id="pred-fixed-load-row">
            <span class="block text-xs font-medium text-slate-400 dark:text-slate-500 mb-1 tracking-wide">Fixed Load (W)</span>
            <input id="pred-fixed-load-w" type="number" min="0" step="10" class="form-input" data-predictions-only="true" />
          </label>
```

- [ ] **Step 2: Update readFormValues in app/src/predictions.js**

Replace the current `readFormValues` function:

```js
function readFormValues() {
  const sensors = parseSilently(getVal('pred-sensors'));
  const derived = parseSilently(getVal('pred-derived'));

  const activeType = getVal('pred-active-type') || 'historical';

  const activeSensor = getVal('pred-active-sensor');
  const activeLookback = getVal('pred-active-lookback');

  const historicalPredictor = activeSensor ? {
    sensor: activeSensor,
    lookbackWeeks: activeLookback ? parseInt(activeLookback, 10) : 4,
    dayFilter: getVal('pred-active-filter') || 'same',
    aggregation: getVal('pred-active-agg') || 'mean',
  } : null;

  const fixedLoadW = getVal('pred-fixed-load-w');
  const fixedPredictor = fixedLoadW ? { load_W: parseFloat(fixedLoadW) } : null;

  const pvConfig = {
    pvSensor: getVal('pred-pv-sensor') || 'Solar Generation',
    latitude: parseFloat(getVal('pred-pv-lat')) || 0,
    longitude: parseFloat(getVal('pred-pv-lon')) || 0,
    historyDays: parseInt(getVal('pred-pv-history'), 10) || 14,
    pvMode: getVal('pred-pv-mode') || 'hourly',
  };

  return {
    ...(sensors !== null ? { sensors } : {}),
    ...(derived !== null ? { derived } : {}),
    activeType,
    ...(historicalPredictor ? { historicalPredictor } : {}),
    ...(fixedPredictor ? { fixedPredictor } : {}),
    pvConfig,
  };
}
```

- [ ] **Step 3: Rename renderLoadConfig → renderHistoricalConfig and update applyConfigToForm**

In `app/src/predictions.js`:

Rename the function (line ~557):
```js
function renderHistoricalConfig(historicalPredictor) {
  if (!historicalPredictor) return;
  setVal('pred-active-sensor', historicalPredictor.sensor ?? '');
  setVal('pred-active-lookback', historicalPredictor.lookbackWeeks ?? '');
  setVal('pred-active-filter', historicalPredictor.dayFilter ?? '');
  setVal('pred-active-agg', historicalPredictor.aggregation ?? '');
}
```

Update `applyConfigToForm` to use new field names (replace the block starting at line ~85):
```js
  renderHistoricalConfig(config.historicalPredictor ?? null);
  setVal('pred-active-type', config.activeType ?? 'historical');
  setVal('pred-fixed-load-w', config.fixedPredictor?.load_W ?? '');
  renderPvConfig(config.pvConfig ?? null);
```

Update `wireForm` to pass the renamed callback:
```js
  initValidation({ readFormValues, renderHistoricalConfig, setComparisonStatus });
```

- [ ] **Step 4: Update predictions-validation.js to use renderHistoricalConfig**

In `app/src/predictions-validation.js`, rename the parameter and all usages:

Line 10: `export function initValidation({ readFormValues, renderHistoricalConfig, setComparisonStatus }) {`

Line 13: `runBtn.addEventListener('click', () => onRunValidation({ readFormValues, renderHistoricalConfig, setComparisonStatus }));`

Line 17: `async function onRunValidation({ readFormValues, renderHistoricalConfig, setComparisonStatus }) {`

Line 47: `renderResults(result, { readFormValues, renderHistoricalConfig, setComparisonStatus });`

Line 154: `async function onUseConfig(row, { readFormValues, renderHistoricalConfig, setComparisonStatus }) {`

Line 155–160: update `activeConfig` → `historicalPredictor` variable name and its call:
```js
  const historicalPredictor = {
    sensor: row.sensor,
    lookbackWeeks: row.lookbackWeeks,
    dayFilter: row.dayFilter,
    aggregation: row.aggregation,
  };

  try {
    renderHistoricalConfig(historicalPredictor);
```

Line 166: update the status message (cosmetic, keep as is or update as preferred).

- [ ] **Step 5: Run full test suite**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add app/index.html app/src/predictions.js app/src/predictions-validation.js
git commit -m "feat: add predictor type selector and fixed load input to UI"
```
