# OptiVolt 🔋

Plan and control a home energy system with forecasts, dynamic tariffs, and a day-ahead optimization pipeline. OptiVolt builds a linear program over 15-minute slots to decide how your **battery**, **PV**, **EV**, **heat pump**, and the **grid** should interact to minimize cost.

- **Primary focus:** Victron Energy ESS systems via the **Victron VRM API** and MQTT Dynamic ESS schedule writing.
- **How to run:** as a **Home Assistant add-on** (recommended) _or_ as a **standalone Node.js server** that serves the web UI and API from the same port.

## Features

- Day-ahead cost minimization over 15-minute slots using HiGHS (WASM)
- Built-in load forecasting based on Home Assistant historical sensor data
- Server-side VRM integration for forecasts/prices and system limits
- Optional Dynamic ESS schedule pushes over MQTT (first 4 slots)
- Heuristic EV charging schedule: routes PV surplus to EV instead of exporting to grid
- Static, build-free web UI served by the same Express process
- Persistent settings + time-series data under a configurable data directory

## Installation

### Home Assistant Add-on (Recommended)

1. **Expose the add-on directory over Samba:**
   Install the Samba share add-on in Home Assistant and configure it so the `/addons` directory is available as a network share. Mount that share on your computer.
2. **Copy the Optivolt files:**
   Copy the contents of your local Optivolt repository into the mounted `addons` share. Using `rsync` (macOS/Linux) skips development artifacts:
   ```bash
   rsync -av --delete --exclude 'node_modules' --exclude '.git' --exclude '.DS_Store' --exclude 'tests' --exclude 'vendor/highs-js' ~/Code/optivolt/ /Volumes/addons/optivolt/
   ```
3. **Install the add-on:**
   Go to **Settings → Add-ons → Add-on Store**. Reload local add-ons if necessary, find **Optivolt**, and click **Install**.
4. **Configure connection settings:**
   Open the Optivolt add-on configuration panel and enter your Victron VRM credentials / installation ID, and the Victron IP address on your local network.
   *(Note: Optivolt automatically connects to the internal HA WebSocket API using the supervisor token to fetch historical sensor data.)*
5. **Start and verify:**
   Start the Optivolt add-on, open the UI, and verify that data (time series, prices, SoC, etc.) is being fetched correctly.

### Standalone / Local Development

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

## Home Assistant Integration

Optivolt is designed to be coordinated heavily via Home Assistant. Below are the steps and examples to automate its features.

### 1. Trigger the Optimizer Loop
Optivolt relies on a periodic trigger to fetch new data, calculate a plan, and (optionally) push it to Victron. Create a REST command to call the `/calculate/` endpoint:
```yaml
rest_command:
  optivolt_calculate:
    url: "http://localhost:3070/calculate/"
    method: POST
    content_type: "application/json"
    payload: >-
      {
        "updateData": true,
        "writeToVictron": true
      }
```

Then create an automation to trigger it every 15 minutes, a few seconds after each quarter hour:
```yaml
automation:
  - alias: "Trigger Optivolt calculate every quarter hour"
    trigger:
      - platform: time_pattern
        minutes: "/15"
        seconds: 5
    action:
      - service: rest_command.optivolt_calculate
```

### 2. Victron DESS Node-RED Mode & Price API Bug
To prevent Victron DESS from overwriting Optivolt's settings, you should set DESS to **Node-RED** mode (e.g., using the HA Victron MQTT extension).

_Workaround:_ There is a bug in the Victron API where **price data is not available** when DESS is not in the default mode. Create a Home Assistant automation that temporarily sets DESS back to **default** mode between **13:00 and 14:00** every day to fetch prices, leaving it in Node-RED mode otherwise.

### 3. Load Forecasting Periodic Trigger (Optional)
Call the endpoint `/predictions/forecast/now` periodically from Home Assistant (via a REST Command) to generate up-to-date load forecasts. Be sure to first configure the predictor on the optimizer page of the UI.
```yaml
rest_command:
  optivolt_predict:
    url: "http://localhost:3070/predictions/forecast/now"
    method: GET
```

### 4. EV Charging Control (Optional)

To let Optivolt control your EV charger based on PV surplus:

1. In the **Settings tab**, enable **EV**, set the charge power, and enter your HA entity IDs for the EV SoC sensor and plug binary sensor.
2. Set the EV data source to `ha` so Optivolt fetches plug/SoC state from HA on each plan run.
3. Poll `GET /ev/current` from HA to get the current slot's charging decision. Example `configuration.yaml`:
```yaml
rest:
  - resource: "http://localhost:3070/ev/current"
    scan_interval: 300
    sensor:
      - name: "OptiVolt EV Should Charge"
        value_template: "{{ value_json.shouldCharge }}"
      - name: "OptiVolt EV Charge Power"
        value_template: "{{ value_json.chargePower_W }}"
        unit_of_measurement: "W"
```
Use `GET /ev/schedule` to retrieve the full day-ahead EV charging schedule.

Charging is triggered only when PV would otherwise be exported to the grid — battery-to-grid arbitrage flows are intentionally excluded.

### 5. Push Custom Pricing / Sensor Data (Optional)
If you don't use VRM for pricing and instead manually push data (by setting data sources to "API" in the UI), you can use the `/data` endpoint.
```yaml
rest_command:
  optivolt_push_prices:
    url: "http://localhost:3070/data"
    method: POST
    content_type: "application/json"
    payload: >-
      {% set import_data = state_attr('sensor.ecopower_consumption_price', 'consumption_data') %}
      {% set export_data = state_attr('sensor.ecopower_injection_price', 'injection_data') %}
      {% set step = 15 %}

      {% set import_start_ts = as_timestamp(as_datetime(import_data[0].time)) | int %}
      {% set export_start_ts = as_timestamp(as_datetime(export_data[0].time)) | int %}

      {% set import_start_iso = import_start_ts | timestamp_custom('%Y-%m-%dT%H:%M:%S.000Z', false) %}
      {% set export_start_iso = export_start_ts | timestamp_custom('%Y-%m-%dT%H:%M:%S.000Z', false) %}

      {
        "importPrice": {
          "start": {{ import_start_iso | tojson }},
          "step": {{ step }},
          "values": {{ (import_data | map(attribute='price') | list) | tojson }}
        },
        "exportPrice": {
          "start": {{ export_start_iso | tojson }},
          "step": {{ step }},
          "values": {{ (export_data | map(attribute='price') | list) | tojson }}
        }
      }
```

## Architecture & HTTP API

```text
app/                 # Static web UI (index.html, main.js, app/src/**)
api/                 # Express server (routes + services)
lib/                 # Core logic: LP builder, parser, DESS mapper, VRM + MQTT clients
addon/               # Home Assistant add-on wrapper (s6, run scripts)
translations/        # i18n strings for the HA add-on settings
Dockerfile           # Image for HA add-on / container use
config.yaml          # Home Assistant add-on manifest
```

The **UI** is static and calls the **Express API** on the same origin. The **API** exposes:

- `POST /calculate` — Builds & solves the LP with **HiGHS** and returns per-slot flows, SoC, DESS mappings, and EV charging schedule. Fast execution. The response includes an `evSchedule` array:
  ```json
  "evSchedule": [
    { "timestampMs": 1704067200000, "chargePower_W": 11000, "shouldCharge": true },
    { "timestampMs": 1704068100000, "chargePower_W": 0, "shouldCharge": false }
  ]
  ```
- `GET/POST /settings` — Reads/writes persisted system + algorithm settings (defaulting to `api/defaults/default-settings.json`).
- `POST /data` — Endpoint to inject custom time-series data. The payload maps arrays of 15m values:
  ```json
  {
    "importPrice": {
      "start": "2024-01-01T00:00:00.000Z",
      "step": 15,
      "values": [10.5, 11.2, 12.0, 11.8]
    }
  }
  ```
- `POST /vrm/refresh-settings` — Fetches latest Dynamic ESS limits/settings from VRM and persists.
- `GET /ev/schedule` — Full EV charging schedule from the latest plan.
- `GET /ev/current` — Current slot's EV charging decision (`shouldCharge`, `chargePower_W`). Returns 404 before any plan is computed or when all slots are in the future.
- `GET/POST /predictions/*` — Load forecasting features (`/validate`, `/forecast`, `/forecast/now`).

*Note:* Data and settings are server-owned. VRM refreshes write to `DATA_DIR/data.json` and the solver always reads from this persisted snapshot.
