# PV Forecasting Implementation Plan

## Context

OptiVolt has load prediction using HA historic data + statistical aggregation. PV forecasting uses a fundamentally different algorithm: capacity-based normalization combining HA production history, Open-Meteo weather data, and a Bird Clear Sky model. The POC in `scripts/pv-forecast-poc.js` validates this algorithm. This plan integrates it following the same clean architecture pattern.

## Time Alignment (critical)

All three data sources must align on the same hour-of-day convention:

| Source | Convention | Hour accessor |
|--------|-----------|---------------|
| HA via `postprocess()` | UTC hours | `getUTCHours()` (line 101 of `ha-postprocess.ts`) |
| Open-Meteo | Request with `timezone=GMT` → returns UTC times | parse → `getUTCHours()` |
| Bird Clear Sky Model | Internally uses `getUTCHours()` + longitude offset for solar time | Timezone-independent ✓ |

**Backward-averaging alignment** (Open-Meteo → HA):
- Open-Meteo `shortwave_radiation` is **backward-averaged**: hour 14:00 = average over 13:00–14:00
- HA statistics use **start time**: hour 13:00 = production during 13:00–14:00
- Same physical interval → align with `intervalStartHour = (omHour + 23) % 24`
- Bird Clear Sky: calculated at **mid-interval** (e.g., 13:30 UTC for the 13:00–14:00 interval)

## Architecture

```
[HA WebSocket]           [Open-Meteo API]
      |                        |
  ha-client.ts       open-meteo-client.ts    ← I/O boundary
      |                        |
  ha-postprocess.ts     open-meteo.ts        ← pure parsing/transforms
      \                      /
    pv-prediction-service.ts                 ← orchestration
               |
         predict-pv.ts                      ← pure core (Bird model, capacity, forecast)
               |
     predictions.ts (route)                 ← API endpoints
               |
     predictions.js (UI)                    ← charts + controls
```

## Route Restructuring

Move current load forecast to its own sub-path, add PV sub-path, and make the existing `/forecast` endpoint compute all predictions:

| Endpoint | Purpose |
|----------|---------|
| `POST /predictions/load/forecast` | Load forecast only (existing `executeForecast` logic moved here) |
| `POST /predictions/pv/forecast` | PV forecast only (new) |
| `POST /predictions/forecast` | Run ALL predictions (load + PV), return combined result |
| `GET /predictions/forecast/now` | Run ALL predictions without recent data (for automated refresh) |
| `POST /predictions/validate` | Load validation (unchanged) |
| `GET /predictions/config` | Config (unchanged, includes pvConfig) |
| `POST /predictions/config` | Save config (unchanged, handles pvConfig via merge) |

The combined `/forecast` endpoint calls both `runForecast()` and `runPvForecast()` in parallel, persists results to `data.load`/`data.pv` when the respective dataSources are set to `'api'`.

## New Files

### 1. `lib/predict-pv.ts` — Pure core

All pure functions, no I/O. Thoroughly commented, especially the Bird model.

**Types:**
```typescript
interface IrradianceRecord {
  time: number;          // timestamp ms (start of UTC hour)
  hour: number;          // 0-23 UTC hour
  ghi_W_per_m2: number;  // shortwave radiation
}

interface PvProductionRecord {
  time: number;          // timestamp ms (start of UTC hour)
  hour: number;          // 0-23 UTC hour
  production_Wh: number; // energy produced in this hour
}

interface HourlyCapacity {
  hour: number;              // 0-23 UTC hour
  maxProduction_Wh: number;  // best observed production for this hour
  maxRatio: number;          // best observed GHI_actual/GHI_clear ratio
  trueCapacity_Wh: number;  // estimated 100%-clear-sky production
}

interface PvForecastPoint {
  time: number;               // timestamp ms
  hour: number;               // 0-23 UTC hour
  ghiClear_W_per_m2: number;  // Bird model clear-sky baseline
  ghiForecast_W_per_m2: number; // Open-Meteo forecast/archive value
  forecastRatio: number;      // ghiForecast / ghiClear
  prediction_Wh: number;     // predicted production
  actual_Wh: number | null;  // measured production (null for future)
}

// Same shape as load ForecastSeries for solver compatibility
interface PvForecastSeries {
  start: string;   // ISO timestamp
  step: number;    // 15 (minutes)
  values: number[]; // watts per 15-min slot
}

interface PvValidationMetrics {
  mae: number;
  rmse: number;
  n: number;
}
```

**Functions:**

- `calculateClearSkyGHI(lat, lon, date)` — Bird Clear Sky Model. Ported from POC. Uses `getUTCHours()` + longitude offset for solar time (timezone-independent). Includes Rayleigh, ozone, gas, water vapor, and aerosol transmittance. Returns GHI in W/m² with 1.10 tuning factor. Heavily commented with references to the Bird model steps.

- `calculateMaxProductionPerHour(records: PvProductionRecord[])` — Returns `number[24]`: max Wh for each UTC hour across all history days.

- `calculateMaxRatioPerHour(irradiance: IrradianceRecord[], lat, lon)` — For each Open-Meteo record: compute Bird GHI at mid-interval, compute ratio `ghi_actual / ghi_clear`, track max per hour. Applies backward-averaging alignment (`intervalStartHour = (omHour + 23) % 24`). Skips records where `ghiClear < 20`. Returns `number[24]`.

- `estimateHourlyCapacity(maxProd, maxRatio)` — `trueCapacity = maxRatio > 0.1 ? maxProd / maxRatio : maxProd`. Returns `HourlyCapacity[24]`.

- `forecastPv(capacity, forecastIrradiance, lat, lon, actuals?)` — For each forecast irradiance record: compute Bird GHI at mid-interval, compute `forecastRatio = ghiForecast / ghiClear`, compute `prediction = forecastRatio * trueCapacity[intervalStartHour]`. Returns `PvForecastPoint[]`.

- `buildPvForecastSeries(points, startIso, endIso)` — Convert hourly Wh points to 15-min Watt slots (each hour → 4 equal slots, Wh → W by dividing by step duration). Same format as load `ForecastSeries` for solver compatibility.

- `validatePvForecast(points)` — Compute MAE, RMSE from points where `actual_Wh !== null`.

### 2. `lib/open-meteo.ts` — Pure URL builders + response parsers

- `buildArchiveUrl({ latitude, longitude, startDate, endDate })` — Returns URL for `archive-api.open-meteo.com` with `hourly=shortwave_radiation&timezone=GMT`
- `buildForecastUrl({ latitude, longitude, model?, pastDays?, forecastDays? })` — Returns URL for `api.open-meteo.com` with `hourly=shortwave_radiation&timezone=GMT`, default model `icon_d2`
- `parseIrradianceResponse(data)` — Parse `{ hourly: { time, shortwave_radiation } }` into `IrradianceRecord[]`, handling null radiation values (default to 0)

### 3. `api/services/open-meteo-client.ts` — Thin HTTP wrapper

- `fetchArchiveIrradiance(lat, lon, startDate, endDate)` → `IrradianceRecord[]`
- `fetchForecastIrradiance(lat, lon, model?)` → `IrradianceRecord[]`

Both use `fetch()`, call the pure URL builders, then parse responses.

### 4. `api/services/pv-prediction-service.ts` — Orchestration

`runPvForecast(config)` pipeline:
1. Fetch historic PV production from HA via `fetchHaStats()` + `postprocess()` → filter by `pvSensor`
2. Fetch historic irradiance from Open-Meteo Archive (same date range as HA data)
3. Capacity estimation: `calculateMaxProductionPerHour` → `calculateMaxRatioPerHour` → `estimateHourlyCapacity`
4. Fetch forecast irradiance from Open-Meteo Forecast (pastDays=1, forecastDays=2)
5. Generate forecast: `forecastPv(capacity, forecastRecords, lat, lon, actualsMap)`
6. Build 15-min series: `buildPvForecastSeries(points, startIso, endIso)`
7. Split points into future (forecast chart) and past with actuals (validation chart)

Returns `{ forecast: PvForecastSeries, points: PvForecastPoint[], recent: PvForecastPoint[] }`

## Modified Files

### 5. `api/types.ts`

Add:
```typescript
export interface PvPredictionConfig {
  latitude: number;
  longitude: number;
  historyDays: number;    // default 14
  pvSensor: string;       // sensor name, e.g. "Solar Generation"
}
```

Add `pvConfig?: PvPredictionConfig` to `PredictionConfig`.

### 6. `api/defaults/default-prediction-config.json`

Add:
```json
"pvConfig": {
  "latitude": 0,
  "longitude": 0,
  "historyDays": 14,
  "pvSensor": "Solar Generation"
}
```

### 7. `api/routes/predictions.ts`

- Move existing `executeForecast` logic to `POST /predictions/load/forecast`
- Add `POST /predictions/pv/forecast` — calls `runPvForecast`, persists to `data.pv` when `dataSources.pv === 'api'`
- Refactor `POST /predictions/forecast` to call both load + PV forecast in parallel, return `{ load: {...}, pv: {...} }`
- Refactor `GET /predictions/forecast/now` similarly

### 8. `app/src/api/api.js`

Add:
- `fetchPvForecast()` → `POST /predictions/pv/forecast`
- Update `fetchForecast()` if combined endpoint changes response shape

### 9. `app/index.html` — PV UI in predictions panel

**Sidebar** (after existing load settings card):
- PV Forecast Settings card:
  - PV Sensor dropdown (populated from same sensors + derived list)
  - Latitude + Longitude inputs (side-by-side)
  - History days input (min=7, max=60, default=14)
  - "Recompute PV" button (amber-colored, distinct from load's green)
  - Summary panel: total kWh, peak W, avg error

**Main area** (after existing load charts):
- PV Forecast chart (`pv-forecast-chart` canvas) — bar chart
- PV Validation chart (`pv-history-chart` canvas) — line chart, predicted vs actual for past period

### 10. `app/src/predictions.js`

- Hydrate PV form fields from `config.pvConfig` on init
- `onPvRecompute()` — save pvConfig → call `fetchPvForecast()` → render charts + summary
- `renderPvForecastChart(forecast, points)` — hourly bar chart (amber/yellow for solar)
- `renderPvHistoryChart(recent)` — two-line chart: predicted vs actual over past days
- PV sensor dropdown populated from same `config.sensors` + `config.derived`
- Auto-save PV settings on change (same debounce pattern)

## Tests

- `tests/lib/predict-pv.test.js` — Bird model known-value tests, capacity estimation edge cases, forecast generation, backward-averaging alignment
- `tests/lib/open-meteo.test.js` — URL builder correctness, response parser null handling

## Solver Integration

No changes to `config-builder.ts`, `build-lp.ts`, or `planner-service.ts`. When `dataSources.pv === 'api'`:
1. PV forecast endpoint writes to `data.pv` (a `TimeSeries`)
2. `config-builder.ts` reads `data.pv` and produces `cfg.pv_W`
3. LP solver uses `pv_W` as-is

## Implementation Order

1. `lib/predict-pv.ts` + `tests/lib/predict-pv.test.js`
2. `lib/open-meteo.ts` + `tests/lib/open-meteo.test.js`
3. `api/types.ts` + `api/defaults/default-prediction-config.json`
4. `api/services/open-meteo-client.ts`
5. `api/services/pv-prediction-service.ts`
6. `api/routes/predictions.ts` — route restructuring + PV endpoints
7. `app/` — UI (HTML + predictions.js + api.js)

## Verification

1. `npx vitest run` — All existing + new tests pass
2. `npm run typecheck` — No type errors
3. `npm run lint` — No lint errors
4. Manual: Configure lat/lon + PV sensor in predictions tab → "Recompute PV" → verify forecast chart shows reasonable solar curve and validation chart shows predicted vs actual alignment
