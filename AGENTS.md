# Optivolt agent guide

## Data + settings model

- The **server** owns the persisted state under `DATA_DIR` (defaults to `<repo>/data`).
  - `settings.json` holds system and algorithm scalars. Defaults live in `api/defaults/default-settings.json`.
  - `data.json` holds time series + SoC and starts from `api/defaults/default-data.json`.
- Time-series data comes from the VRM API (via `vrm-refresh.js`) and is persisted server-side. The client only visualizes it.
- The LP config (`lib/build-lp.js`) is derived from persisted settings + data; the client never sends LP parameters.

## Front-end layout
- Static UI lives in `app/index.html` and `app/main.js`.
- Browser-side modules under `app/scr/`:

  - `app/scr/api/client.js` — low-level `getJson` / `postJson`.
  - `app/scr/api/settings.js` — `/settings` helpers.
  - `app/scr/api/solver.js` — `/calculate` helper (can toggle VRM refresh / MQTT write).
  - `app/scr/config-store.js` — loads and saves the current settings snapshot via the API.
  - `app/scr/api/backend.js` — VRM settings refresh.
  - `app/scr/charts.js`, `app/scr/table.js` — visualization only.
  - `app/scr/utils.js` — small utilities (e.g. debounce).

### Settings on the client

- On boot, `loadInitialConfig()` calls `GET /settings` and returns `{ config, source }` (defaults come from the API if no file exists).
- `hydrateUI(config)` writes scalar + algorithm settings into form fields; the plan metadata fields (SoC, timestamps) are display-only.
- Time-series **data** (load, PV, prices, SoC) are **not editable**; they come from VRM and are shown via graphs/table only.
- `snapshotUI()` collects:
  - **system settings** (battery capacity, step size, grid/battery limits, …),
  - **algorithm settings** (terminal SoC mode, custom price, …),
  - UI-only bits (e.g. `tableShowKwh`).

Snapshots are saved via `POST /settings` when inputs change (debounced) and before a recompute.

## API routes

All routes are implemented in `api/`. Important ones:

- `GET /settings` — returns persisted settings or defaults when missing.
- `POST /settings` — merges the incoming object onto existing settings and writes to `DATA_DIR/settings.json`.
- `POST /calculate` — builds the LP from persisted settings + data, runs HiGHS, and returns rows/summary/diagnostics. Optional body flags: `updateData` (refresh VRM series before solving) and `writeToVictron` (attempt MQTT schedule write).
- `POST /vrm/refresh-settings` — refresh relatively static system limits/settings from VRM and persist.

## PR / testing notes
- Prefer small, focused commits with descriptive messages.
- Run `npm run lint` or relevant integration checks when modifying solver or API behaviour. Document executed commands in the final summary.
