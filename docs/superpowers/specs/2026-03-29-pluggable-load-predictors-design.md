# Pluggable Load Predictors

**Date:** 2026-03-29

## Background

The current load prediction system has a single `activeConfig` in `PredictionConfig` that always uses historical HA data (week-based averaging). When the house is empty (e.g., vacation), the historical predictor produces unrealistic forecasts. A fixed constant load is a better fit for those periods. Looking further ahead, a weather-dependent heat pump predictor may be combined with a residual load predictor next winter.

## Design

### Config structure

Replace the single `activeConfig?: PredictionActiveConfig` in `PredictionConfig` with three fields:

```ts
activeType: 'historical' | 'fixed';
historicalPredictor?: {
  sensor: string;
  lookbackWeeks: number;
  dayFilter: DayFilter;
  aggregation: Aggregation;
};
fixedPredictor?: { load_W: number };
```

Both sub-configs are always persisted. `activeType` is the only thing that changes when switching modes — historical settings survive a round-trip to fixed and back. The `LoadPredictor` discriminated union is assembled at runtime for use in the service layer:

```ts
export type LoadPredictor =
  | { type: 'historical'; sensor: string; lookbackWeeks: number; dayFilter: DayFilter; aggregation: Aggregation }
  | { type: 'fixed'; load_W: number }
```

`PredictionActiveConfig` is removed from the codebase.

### File rename

`lib/predict-load.ts` → `lib/load-predictor-historical.ts`. The file contains only historical prediction logic; the new name reflects that. All exports and callers are updated.

### Service layer (`api/services/load-prediction-service.ts`)

`runForecast()` assembles the active `LoadPredictor` from the config and branches:

- `type: 'historical'`: existing behavior — fetch HA stats, call `predict()`, build series.
- `type: 'fixed'`: no HA fetch. Call `getForecastTimeRange()` to get the window, fill every 15-min slot with `load_W`, return a `ForecastSeries`. `recent` and `metrics` are empty/NaN.

### Migration

`prediction-config-store.ts` migrates old stored JSON on read: if `activeConfig` is present and `historicalPredictor` is absent, wrap `activeConfig` as `historicalPredictor` and set `activeType: 'historical'`. The default config JSON (`api/defaults/default-prediction-config.json`) is updated to the new structure.

### UI

The prediction config panel gets a predictor type toggle (`historical` / `fixed`). Both sub-configs are always visible and editable regardless of which is active — this ensures historical settings are not lost when switching to fixed. On save, the full config (both sub-configs + `activeType`) is sent to the server.

## Testing

- **Fixed predictor**: given `activeType: 'fixed'` and `load_W: 200`, the returned `ForecastSeries` has all values equal to 200 with correct start/step/length.
- **Migration**: an old stored config with `activeConfig` (no `historicalPredictor`) is correctly read as `historicalPredictor` + `activeType: 'historical'`.
- **Existing historical tests**: continue to pass unchanged against `load-predictor-historical.ts`.

## Future extensibility

Adding a weather-dependent predictor next winter means adding a new union member to `LoadPredictor` and a corresponding sub-config field (e.g., `weatherPredictor?`). If combining predictors is needed, `activeType` can be extended to `'combined'` with a list of component predictors — no structural rework required.
