# OptiVolt 🔋

Plan and control a home energy system with forecasts, dynamic tariffs, and a day-ahead optimization. Optivolt builds a linear program over 15-minute slots to decide how your **battery**, **PV**, **EV**, **heat pump**, and the **grid** should interact to minimize cost.

- **Primary focus:** Victron Energy ESS systems via the **Victron VRM API** (site ID + token).
- **How to run:** as a **Home Assistant add-on** (recommended) _or_ as a **standalone Node.js server** that serves the web UI and API from the same port.

## Features

- Day-ahead cost minimization over 15-minute slots
- Explicit handling of price-based behavior (import/export arrays, terminal SoC valuation)
- Server-side VRM integration
- Simple, static web UI (no build pipeline) served by the same process
- Persistent settings

## Architecture

- The **UI** (in `app/`) is static and calls the **Express API** on the same origin.
- The **API** (in `api/`) exposes:
  - `/calculate` — builds & solves the LP with **HiGHS** (WASM) and returns per-slot flows + SoC.
  - `/settings` — read/write persisted UI/settings JSON.
  - `/vrm/*` — server-side helpers that talk to **Victron VRM** using env-provided credentials.
- Shared logic lives in **`lib/`**.

```
app/                 # static web UI (index.html, main.js, app/scr/**)
api/                 # Express server (index.js + routes)
lib/                 # core logic: LP builder, parser, DESS, VRM client, defaults
addon/               # Home Assistant add-on wrapper (s6, run scripts)
cli/                 # small CLI helper for local smoke tests
examples/            # LP and config examples
translations/        # i18n strings for the HA addon settings
Dockerfile           # image for HA add-on / container use
config.yaml          # Home Assistant add-on manifest
```

### Running the server

```bash
npm install
npm run api
```

By default the server listens on `http://localhost:3000`.

**Environment variables:**

- `HOST` (default `0.0.0.0`), `PORT` (default `3000`)
- `DATA_DIR` (default `<repo>/data`)
- `VRM_INSTALLATION_ID`, `VRM_TOKEN` (enable `/vrm/*` routes)

Create a `.env.local` file in the project root to set these variables for local development.
