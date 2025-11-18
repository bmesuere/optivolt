# OptiVolt 🔋

Plan and control a home energy system with forecasts, dynamic tariffs, and a day-ahead optimization pipeline. OptiVolt builds a linear program over 15-minute slots to decide how your **battery**, **PV**, **EV**, **heat pump**, and the **grid** should interact to minimize cost.

- **Primary focus:** Victron Energy ESS systems via the **Victron VRM API** and MQTT Dynamic ESS schedule writing.
- **How to run:** as a **Home Assistant add-on** (recommended) _or_ as a **standalone Node.js server** that serves the web UI and API from the same port.

## Features

- Day-ahead cost minimization over 15-minute slots using HiGHS (WASM)
- Server-side VRM integration for forecasts/prices and system limits
- Optional Dynamic ESS schedule pushes over MQTT (first 4 slots)
- Static, build-free web UI served by the same Express process
- Persistent settings + time-series data under a configurable data directory

## Architecture

- The **UI** (in `app/`) is static and calls the **Express API** on the same origin.
- The **API** (in `api/`) exposes:
  - `POST /calculate` — builds & solves the LP with **HiGHS** and returns per-slot flows, SoC, and DESS mappings. The request body can ask the server to refresh VRM data first and/or push the first slots to Victron via MQTT.
  - `GET/POST /settings` — read/write persisted system + algorithm settings in `DATA_DIR/settings.json` (defaulting to `api/defaults/default-settings.json`).
  - `POST /vrm/refresh-settings` — fetch latest Dynamic ESS limits/settings from VRM and persist.
- Data (forecasts, prices, SoC) are server-owned: VRM refreshes write to `DATA_DIR/data.json` (defaulting to `api/defaults/default-data.json`) and the solver always reads from this persisted snapshot.
- Shared logic lives in **`lib/`** (LP builder/parser, DESS mapping, VRM + MQTT clients).

```
app/                 # Static web UI (index.html, main.js, app/scr/**)
api/                 # Express server (routes + services)
lib/                 # Core logic: LP builder, parser, DESS mapper, VRM + MQTT clients
addon/               # Home Assistant add-on wrapper (s6, run scripts)
translations/        # i18n strings for the HA add-on settings
Dockerfile           # Image for HA add-on / container use
config.yaml          # Home Assistant add-on manifest
```

### Running the server locally

```bash
npm install
npm run api       # or: npm run dev  (loads .env.local via dotenv-cli + nodemon)
```

By default the server listens on `http://localhost:3000`.

**Environment variables:**

- `HOST` (default `0.0.0.0`), `PORT` (default `3000`)
- `DATA_DIR` (default `<repo>/data`); stores `settings.json` and `data.json`
- `VRM_INSTALLATION_ID`, `VRM_TOKEN` (enable VRM refresh routes)
- `MQTT_HOST`, `MQTT_PORT`, `MQTT_USERNAME`, `MQTT_PASSWORD` (optional; required to push Dynamic ESS schedules)

Create a `.env.local` file in the project root to set these variables for local development.
