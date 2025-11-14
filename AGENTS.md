# Optivolt agent guide

## High-level model

- The **server** owns the persisted settings in `DATA_DIR/settings.json`.
- The **UI** is just a view/editor for:
  - long-lived **system settings** (battery, grid limits, slot duration, …),
  - short-lived **data** (load / PV / price time series, SoC),
  - tunable **algorithm settings** (terminal SoC valuation, future knobs).
- The **LP config** (`lib/build-lp.js`) is derived _only_ from the persisted settings on the server; the client never sends LP parameters anymore.

Default values live in `lib/default-settings.json`.
If `settings.json` is missing, the server returns these defaults.

## Front-end layout
- Static UI lives in `app/index.html` and `app/main.js`.
- Browser-side modules under `app/scr/`:

  - `app/scr/api/client.js` — low-level `getJson` / `postJson`.
  - `app/scr/api/settings.js` — `/settings` helpers.
  - `app/scr/api/solver.js` — `/calculate` helper (no config in the body).
  - `app/scr/config-store.js` — loads and saves the current settings snapshot via the API.
  - `app/scr/charts.js`, `app/scr/table.js` — visualization only.
  - `app/scr/utils.js` — small utilities (e.g. debounce).

### Settings on the client

- On boot, `loadInitialConfig()` calls `GET /settings` and returns `{ config, source }`
- `hydrateUI(config)` writes the scalar & algorithm settings into form fields.
- Time-series **data** (load, PV, prices, SoC) are **not editable** in the form in the target design; they’re fetched from VRM and shown via graphs/table only.
- `snapshotUI()` only collects:
  - **system settings** (battery capacity, step size, grid/battery limits, …),
  - **algorithm settings** (terminal SoC mode, custom price, …),
  - UI-only bits (e.g. `tableShowKwh`).

Snapshots are saved via `POST /settings` when inputs change, using debounced auto-save, and immediately before a recompute.


## API routes

All routes are implemented in `api/`. Important ones:

- `GET /settings` — returns the persisted settings or the defaults from `lib/default-settings.json` when `settings.json` is missing.
- `POST /settings` — accepts a single JSON object, writes it to `DATA_DIR/settings.json` (no partial updates).
- `POST /calculate` — ignores the request body; builds the LP config and timing entirely from persisted settings, runs the solver, and returns the computed results (including schedules, costs, and any relevant diagnostics) as a JSON response.

## PR / testing notes
- Prefer small, focused commits with descriptive messages.
- Run `npm test` or relevant integration checks when modifying solver or API behaviour. Document executed commands in the final summary.
