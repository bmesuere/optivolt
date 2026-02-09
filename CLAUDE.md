# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

OptiVolt is a linear-programming optimizer for home energy systems (battery, PV, EV, heat pump, grid). It builds a day-ahead cost-minimization plan over 15-minute slots using the HiGHS solver (WASM). Primary target: Victron Energy ESS systems via the VRM API + MQTT Dynamic ESS schedule writing. Runs as a Home Assistant add-on or standalone Node.js server.

## Commands

- **Run server:** `npm run api` (or `npm run dev` for nodemon + `.env.local`)
- **Run all tests:** `npm test` (vitest, runs in watch mode)
- **Run tests once:** `npx vitest run`
- **Run a single test file:** `npx vitest run tests/lib/build-lp.test.js`
- **Lint:** `npm run lint`

## Architecture

The system has three layers, all plain ESM (no build step, no TypeScript):

### `lib/` — Core logic (pure, no I/O)
- **`build-lp.js`** — Generates an LP problem string from time-series data and settings. The LP has per-slot flow variables (`grid_to_load`, `pv_to_battery`, `battery_to_grid`, etc.) and tracks `soc` (state of charge) evolution with charge/discharge efficiency.
- **`parse-solution.js`** — Parses HiGHS solver output back into per-slot row objects with flows, SoC percentages, import/export, and timestamps.
- **`dess-mapper.js`** — Maps solved rows to Victron Dynamic ESS schedule parameters (strategy, restrictions, feed-in, target SoC). Produces per-slot DESS decisions and diagnostics.
- **`vrm-api.js`** / **`victron-mqtt.js`** — VRM REST client and MQTT client for writing schedules to Victron.

### `api/` — Express server
- **`app.js`** — Express app setup. Mounts routes at `/calculate`, `/settings`, `/vrm`, and serves the static UI from `app/`.
- **`index.js`** — Server entry point (listens on `HOST`/`PORT`).
- **Routes** (`api/routes/`): `calculate.js`, `settings.js`, `vrm.js`.
- **Services** (`api/services/`):
  - `planner-service.js` — Orchestrates the full pipeline: refresh VRM data → load settings/data → build LP → solve with HiGHS → parse → map to DESS → optionally write via MQTT.
  - `settings-store.js` / `data-store.js` — JSON file persistence under `DATA_DIR` (defaults to `data/`).
  - `solver-input-service.js` — Merges persisted settings + data into solver inputs.
  - `vrm-refresh.js` — Fetches time-series from VRM and persists to `data.json`.
  - `mqtt-service.js` — Writes Dynamic ESS schedule via MQTT.
- **Defaults** (`api/defaults/`): `default-settings.json` and `default-data.json` used when no persisted files exist.

### `app/` — Static web UI (no build step)
- `index.html` + `main.js` — Entry points.
- `app/scr/` — Browser modules: API client, config store, charts, table, utils.
- The UI calls the Express API on the same origin. Time-series data is display-only (comes from VRM, not editable).

### Data flow
Settings and time-series data are server-owned, persisted as JSON under `DATA_DIR`. The client reads/writes settings via `/settings` and triggers computation via `POST /calculate`. The LP is always built server-side from persisted state — the client never sends LP parameters directly.

## Testing

Tests use vitest with supertest for API tests. Test files mirror the source structure under `tests/`. API tests mock external services (`settings-store`, `data-store`, `vrm-refresh`, `mqtt-service`). The `lib/` tests are pure unit tests. Browser-side tests (`tests/app/`) use jsdom.

## Code conventions

- ESM modules throughout (`"type": "module"` in package.json).
- Node.js >= 22 required.
- Express 5.
- Unused variables prefixed with `_` (eslint rule).
- ESLint also checks `.md` and `.css` files.
- Units are explicit in variable names: `_W` (watts), `_Wh` (watt-hours), `_percent`, `_m` (minutes), `_cents_per_kWh`.
- LP variable naming pattern: `{source}_to_{sink}_{slot_index}` (e.g., `grid_to_battery_3`).
