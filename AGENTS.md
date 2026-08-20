# Optivolt agent guide

## Data + settings model

- The **server** owns the persisted state under `DATA_DIR` (defaults to `<repo>/data`).
  - `settings.json` holds system and algorithm scalars. Defaults live in `api/defaults/default-settings.json`.
  - `data.json` holds time series + SoC and starts from `api/defaults/default-data.json`.
  - `prediction-config.json` holds load/PV prediction model settings.
- Time-series data comes from the VRM API (via `api/services/vrm-refresh.ts`) or `/data`/prediction endpoints when a data source is set to `api`. The client only visualizes it.
- Manual prediction adjustments are stored in `data.json` and applied on forecast responses without changing the raw persisted forecast series.
- The LP config (`lib/build-lp.ts`) is derived from persisted settings + data; the client never sends LP parameters.

## Front-end layout
- Static UI lives in `app/index.html` and `app/main.js`.
- Browser-side modules under `app/src/`:

  - `app/src/api/client.js` — low-level `getJson` / `postJson`.
  - `app/src/api/api.js` — endpoint wrappers (settings, calculate, VRM refresh, predictions, EV/HA helpers).
  - `app/src/config-store.js` — loads and saves the current settings snapshot via the API.
  - `app/src/charts.js` — compatibility barrel for chart modules under `app/src/charts/`.
  - `app/src/predictions.js` — Predictions tab coordinator; detailed form/chart logic lives under `app/src/predictions/`.
  - `app/src/ev-settings.js`, `app/src/ev-tab.js` — EV settings wiring and EV tab visualization.
  - `app/src/table.js` — schedule table visualization.
  - `app/src/utils.js` — small utilities (e.g. debounce).

### Settings on the client

- On boot, `loadInitialConfig()` calls `GET /settings` and returns `{ config, source }` (defaults come from the API if no file exists).
- `hydrateUI(config)` writes scalar + algorithm settings into form fields; the plan metadata fields (SoC, timestamps) are display-only.
- Time-series **data** (load, PV, prices, SoC) are **not editable**; they come from VRM and are shown via graphs/table only.
- `snapshotUI()` collects:
  - **system settings** (battery capacity, step size, grid/battery limits, …),
  - **algorithm settings** (terminal SoC mode, custom price, …),
  - **data-source and EV settings**,
  - UI-only bits (e.g. `tableShowKwh`).

Snapshots are saved via `POST /settings` when inputs change (debounced) and before a recompute.

## API routes

All routes are implemented in `api/`. Important ones:

- `GET /settings` — returns persisted settings or defaults when missing.
- `POST /settings` — merges the incoming object onto existing settings and writes to `DATA_DIR/settings.json`.
- `POST /calculate` — builds the LP from persisted settings + data, runs HiGHS, and returns rows/summary/diagnostics. Optional body flags: `updateData` (refresh VRM series before solving) and `writeToVictron` (attempt MQTT schedule write).
- `GET /calculate/last` — the cached plan, when it solved optimally and still covers the current slot; 404 otherwise.
- `GET /data`, `POST /data` — read or merge persisted time-series data.
- `POST /vrm/refresh-settings` — refresh relatively static system limits/settings from VRM and persist.
- `GET/POST /predictions/config`, `/predictions/validate`, `/predictions/*/forecast`, `/predictions/adjustments` — prediction config, validation, forecast generation, and manual adjustment CRUD.
- `GET /ev/current`, `GET /ev/schedule` — current and full EV charging schedule from the last computed plan.
- `/ev/schedule-entries` — CRUD for the typed arrival/departure/target entries persisted in `data.json`.
- `GET /ha/entity/:entityId` — live Home Assistant entity lookup for settings validation.
- `GET /health` — liveness probe.

Prediction routing lives in `api/routes/predictions.ts`; orchestration and persistence helpers live in `api/services/prediction-forecast-runner.ts` and `api/services/prediction-adjustment-store.ts`.

## PR / testing notes
- Prefer small, focused commits with descriptive messages.
- Run `npm run typecheck`, `npm run lint`, or relevant integration checks when modifying solver or API behaviour. Use `npm run test:run` for a one-shot test suite. Document executed commands in the final summary.
