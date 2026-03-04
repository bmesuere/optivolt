# 15-Minute PV Forecast Resolution

## Context
PV forecast currently uses hourly resolution from Open-Meteo's `&hourly=shortwave_radiation`. Open-Meteo also offers `&minutely_15=shortwave_radiation` which gives 4x finer granularity — better matching the solver's 15-minute slot structure. Currently `buildForecastSeries` repeats each hourly value across all 4 quarter-hour slots, losing intra-hour variation. This change adds a configurable `forecastResolution` parameter (default 60 min, opt-in to 15 min) and properly propagates sub-hourly data through the pipeline.

---

## Changes

### 1. Type: add `forecastResolution` to config
**`api/types.ts`** — Add `forecastResolution?: 15 | 60` to `PvPredictionConfig`

### 2. Open-Meteo URL + parser
**`lib/open-meteo.ts`**

- `ForecastUrlParams`: add optional `resolution?: 15 | 60`
- `buildForecastUrl`: use `&minutely_15=shortwave_radiation` when resolution=15, `&hourly=shortwave_radiation` when 60
- `IrradianceRecord` (exported from `predict-pv.ts`): add `intervalMinutes: number` field
- `parseIrradianceResponse` (existing, hourly): set `intervalMinutes: 60` on each record
- New `parseMinutely15Response`: parse `data.minutely_15.time[]` and `data.minutely_15.shortwave_radiation[]`, **no backward-averaging shift** (Open-Meteo labels 15-min data at interval start), extract `hour` from timestamp, set `intervalMinutes: 15`
- Export a `parseForecastResponse(data, resolution)` that dispatches to the right parser

### 3. Open-Meteo client
**`api/services/open-meteo-client.ts`**

- `fetchForecastIrradiance(lat, lon, model?, resolution?: 15|60)`: pass resolution to `buildForecastUrl` and use `parseForecastResponse`

### 4. PV prediction: mid-interval calculation
**`lib/predict-pv.ts`**

- `forecastPv` (line 306): change `rec.time + 30 * 60 * 1000` to `rec.time + (rec.intervalMinutes / 2) * 60 * 1000`
- `calculateMaxRatioPerHour` (line ~234): same hardcoded `30 * 60 * 1000` — update for consistency since archive records will now carry `intervalMinutes: 60`

### 5. `buildForecastSeries` for 15-min points
**`lib/time-series-utils.ts`** (lines 110–138)

Currently buckets all forecast points by hour start:
```ts
const h = Math.floor(p.time / 3600000) * 3600000;
predMap.set(h, p.value);
```
Then for each 15-min step, looks up the hourly bucket — repeating the same value 4x.

**Fix**: Accept an optional `inputStep?: number` parameter (default 60 for backward compat).
- When `inputStep === 15`: map by exact 15-min-aligned timestamp (`Math.floor(p.time / 900000) * 900000`), look up each step directly
- When `inputStep === 60`: use hour alignment (existing behavior)

### 6. PV prediction service: thread resolution through
**`api/services/pv-prediction-service.ts`**

- Extract `forecastResolution = pvConfig.forecastResolution ?? 60`
- Pass to `fetchForecastIrradiance(lat, lon, undefined, forecastResolution)`
- Pass `forecastResolution` to `buildForecastSeries` as `inputStep`
- NOTE: `archiveIrradiance` remains hourly to match HA's hourly long-term statistics

### 7. UI: resolution dropdown
**`app/index.html`** — Add `<select id="pred-pv-resolution">` with options 15/60 in the PV Forecasting section (default selected: 60)

**`app/src/predictions.js`**:
- `renderPvConfig`: set `pred-pv-resolution` value (default 60)
- `readFormValues`: extract `forecastResolution: parseInt(getVal('pred-pv-resolution'), 10) || 60`

### 8. Tests
- `tests/lib/open-meteo.test.js`: add tests for 15-min URL building and `parseMinutely15Response`; update existing tests to check `intervalMinutes: 60` on hourly records
- `tests/lib/predict-pv.test.js`: update `IrradianceRecord` fixtures to include `intervalMinutes`; test mid-interval calculation uses it
- `tests/lib/time-series-utils.test.js` (if exists): test `buildForecastSeries` with `inputStep=15`

---

## Verification
1. `npm run typecheck` — no type errors
2. `npx vitest run` — all tests pass
3. Manual: start UI, set resolution to 15 min, run PV forecast. Verify chart shows 4x more data points in the future portion compared to 60-min mode
4. Manual: check that `data.pv` saved to disk has distinct values per 15-min slot (not 4 identical values per hour)
