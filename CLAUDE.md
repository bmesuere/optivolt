# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

OptiVolt is a linear-programming optimizer for home energy systems (battery, PV, EV, heat pump, grid). It builds a day-ahead cost-minimization plan over 15-minute slots using the HiGHS solver (WASM). Primary target: Victron Energy ESS systems via the VRM API + MQTT Dynamic ESS schedule writing. Runs as a Home Assistant add-on or standalone Node.js server.

## Commands

- **Run server:** `npm run api` (or `npm run dev` for nodemon + `.env.local`)
- **Run tests in watch mode:** `npm test`
- **Run tests once:** `npm run test:run`
- **Run a single test file:** `npx vitest run tests/lib/build-lp.test.js`
- **Typecheck:** `npm run typecheck`
- **Lint:** `npm run lint`

## Architecture

The system has three layers. Server/core code is TypeScript ESM executed directly by Node 22; the browser UI is static ESM with no build step.

### `lib/` — Core logic (pure, no I/O unless noted)
- **`build-lp.ts`** — Generates an LP problem string from time-series data and settings. The LP has per-slot flow variables (`grid_to_load`, `pv_to_battery`, `battery_to_grid`, EV flows, etc.) and tracks `soc` evolution with charge/discharge efficiency.
- **`parse-solution.ts`** — Parses HiGHS solver output back into per-slot row objects with flows, SoC percentages, import/export, EV decisions, and timestamps.
- **`dess-mapper.ts`** — Maps solved rows to Victron Dynamic ESS schedule parameters (strategy, restrictions, feed-in, target SoC). Produces per-slot DESS decisions and diagnostics.
- **`vrm-api.ts`** / **`victron-mqtt.ts`** — VRM REST client and MQTT client for writing schedules to Victron.

### `api/` — Express server
- **`app.ts`** — Express app setup. Mounts routes at `/calculate`, `/settings`, `/data`, `/vrm`, `/predictions`, `/ev`, `/ha`, and serves the static UI from `app/`.
- **`index.ts`** — Server entry point (listens on `HOST`/`PORT`).
- **Routes** (`api/routes/`): `calculate.ts`, `settings.ts`, `data.ts`, `vrm.ts`, `predictions.ts`, `ev.ts`, `ha.ts`.
- **Services** (`api/services/`):
  - `planner-service.ts` — Orchestrates the full pipeline: refresh VRM data, load settings/data, build LP, solve with HiGHS, parse, map to DESS, optionally write via MQTT.
  - `settings-store.ts` / `data-store.ts` / `prediction-config-store.ts` — JSON file persistence under `DATA_DIR` (defaults to `data/`).
  - `config-builder.ts` — Merges persisted settings + data into solver inputs.
  - `vrm-refresh.ts` — Fetches time-series from VRM and persists to `data.json`.
  - `prediction-forecast-runner.ts` / `prediction-adjustment-store.ts` — Prediction orchestration, forecast persistence policy, and manual adjustment CRUD.
  - `mqtt-service.ts` — Writes Dynamic ESS schedule via MQTT.
- **Defaults** (`api/defaults/`): `default-settings.json` and `default-data.json` used when no persisted files exist.

### `app/` — Static web UI (no build step)
- `index.html` + `main.js` — Entry points.
- `app/src/` — Browser modules: API client, config store, chart barrels/modules, predictions modules, EV modules, table, utils.
- The UI calls the Express API on the same origin. Time-series data is display-only (comes from VRM, not editable).

### Data flow
Settings, prediction config, and time-series data are server-owned, persisted as JSON under `DATA_DIR`. The client reads/writes settings via `/settings`, prediction config via `/predictions/config`, and triggers computation via `POST /calculate`. The LP is always built server-side from persisted state — the client never sends LP parameters directly.

## Testing

Tests use vitest with supertest for API tests. Test files mirror the source structure under `tests/`. API tests mock external services (`settings-store`, `data-store`, `vrm-refresh`, `mqtt-service`). The `lib/` tests are pure unit tests. Browser-side tests (`tests/app/`) use jsdom.

## Code conventions

- ESM modules throughout (`"type": "module"` in package.json).
- TypeScript is used in `api/` and `lib/`; browser files under `app/` remain build-free JavaScript modules.
- Node.js >= 22 required.
- Express 5.
- Unused variables prefixed with `_` (eslint rule).
- ESLint also checks `.md` and `.css` files.
- Units are explicit in variable names: `_W` (watts), `_Wh` (watt-hours), `_percent`, `_m` (minutes), `_cents_per_kWh`.
- LP variable naming pattern: `{source}_to_{sink}_{slot_index}` (e.g., `grid_to_battery_3`).
