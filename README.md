# OptiVolt 🔋

Plan and control a home energy system with forecasts, dynamic tariffs, and a day-ahead optimization pipeline. OptiVolt builds a linear program over 15-minute slots to decide how your **battery**, **PV**, **EV**, **heat pump**, and the **grid** should interact to minimize cost.

- **Primary focus:** Victron Energy ESS systems via the **Victron VRM API** and MQTT Dynamic ESS schedule writing.
- **How to run:** as a **Home Assistant App** (recommended) _or_ as a **standalone Node.js server** that serves the web UI and API from the same port.

## Features

- Day-ahead cost minimization over 15-minute slots using HiGHS (WASM)
- Built-in load forecasting based on Home Assistant historical sensor data
- Server-side VRM integration for forecasts/prices and system limits
- Optional Dynamic ESS schedule pushes over MQTT (first 4 slots)
- EV charging integration: LP-optimized schedule with departure deadline, target SoC, and per-slot charge mode classification
- Static, build-free web UI served by the same Express process
- Persistent settings + time-series data under a configurable data directory

## Installation

### Home Assistant App (Recommended)

1. **Expose the add-on directory over Samba:**
   Install the Samba share App in Home Assistant and configure it so the `/addons` directory is available as a network share. Mount that share on your computer. Apps used to be add-ons in Home Assistant, this has been changed in the ui but not yet on the file system, so this directory is called addons.
2. **Copy the Optivolt files:**
   Copy the contents of your local Optivolt repository into the mounted `addons` share. Using `rsync` (macOS/Linux) skips development artifacts:
   ```bash
   rsync -av --delete --exclude 'node_modules' --exclude '.git' --exclude '.DS_Store' --exclude 'tests' --exclude 'vendor/highs-js' ~/Code/optivolt/ /Volumes/addons/optivolt/
   ```
3. **Install the App:**
   Go to **Settings → Apps → Install App**. Reload local Apps if necessary (click check for updates), find **Optivolt**, and click **Install**.
4. **Configure connection settings:**
   Open the Optivolt App configuration panel and enter your Victron VRM credentials / installation ID, and the Victron IP address on your local network.
   *(Note: Make sure mqtt access is enabled on your local Venus OS device: open the remote console: Settings, Services → toggle the MQTT access switch.)*
   *(Note: Optivolt automatically connects to the internal HA WebSocket API using the supervisor token to fetch historical sensor data.)*
5. **Start and verify:**
   Start the Optivolt App, open the UI, and verify that data (time series, prices, SoC, etc.) is being fetched correctly.

### Standalone / Local Development

```bash
npm install
npm run api       # or: npm run dev  (loads .env.local via dotenv-cli + nodemon)
```

By default the server listens on `http://localhost:3000`.

**Environment variables:**
- `HOST` (default `0.0.0.0`), `PORT` (default `3000`)
- `DATA_DIR` (default `<repo>/data`); stores `settings.json`, `data.json`, and `prediction-config.json`
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

### 4. Push Custom Pricing / Sensor Data (Optional)
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

### 5. EV Charger Control via REST Sensor (Optional)

Poll the `/ev/current` endpoint every minute to get the current slot's EV charging decision. Add this to your HA `configuration.yaml`:

```yaml
rest:
  - resource: http://localhost:3070/ev/current
    scan_interval: 60
    sensor:
      - name: "OptiVolt EV Charge Mode"
        value_template: "{{ value_json.ev_charge_mode }}"
        unique_id: optivolt_ev_charge_mode

      - name: "OptiVolt EV Charge Current"
        value_template: "{{ value_json.ev_charge_A }}"
        unit_of_measurement: A
        device_class: current
        unique_id: optivolt_ev_charge_current_a
```

Use `sensor.optivolt_ev_charge_mode` and `sensor.optivolt_ev_charge_current_a` in automations to control your charger. The mode values are `off`, `fixed`, `solar_only`, `solar_grid`, and `max`; the current is the target charge rate in amps.

## Architecture & HTTP API

```text
app/                 # Static web UI (index.html, main.js, app/src/**)
api/                 # Express TypeScript server (routes + services)
lib/                 # TypeScript core logic: LP builder, parser, DESS mapper, VRM + MQTT clients
addon/               # Home Assistant add-on wrapper (s6, run scripts)
translations/        # i18n strings for the HA add-on settings
Dockerfile           # Image for HA add-on / container use
config.yaml          # Home Assistant add-on manifest
```

The **UI** is static and calls the **Express API** on the same origin. Server-owned state lives in `DATA_DIR`:

- `settings.json` stores system, algorithm, Home Assistant, data-source, and EV settings.
- `data.json` stores time-series data, current SoC, and manual prediction adjustments.
- `prediction-config.json` stores load/PV prediction model configuration.

Data-source behavior is explicit: when a data source is set to `vrm`, VRM refreshes own that series in `data.json`; when set to `api`, pushed data or prediction endpoints may write that series. The solver always reads persisted settings and data server-side.

The **API** exposes:

- `GET /settings` — Reads persisted settings, or `api/defaults/default-settings.json` when missing.
- `POST /settings` — Merges the incoming settings object into `DATA_DIR/settings.json`.
- `GET /data` — Reads persisted time-series data.
- `POST /data` — Injects custom time-series data. The payload maps arrays of 15m values:
  ```json
  {
    "importPrice": {
      "start": "2024-01-01T00:00:00.000Z",
      "step": 15,
      "values": [10.5, 11.2, 12.0, 11.8]
    }
  }
  ```
- `POST /calculate` — Builds and solves the LP with **HiGHS** from persisted settings/data. Optional body flags: `updateData` refreshes VRM series before solving, and `writeToVictron` attempts an MQTT DESS schedule write.
- `POST /vrm/refresh-settings` — Fetches latest Dynamic ESS limits/settings from VRM and persists.
- `GET /predictions/config` — Reads prediction configuration plus `isAddon`.
- `POST /predictions/config` — Saves prediction configuration. Home Assistant URL/token are intentionally stored in `/settings`, not this file.
- `GET /predictions/adjustments` — Lists active manual forecast adjustments and prunes expired ones.
- `POST /predictions/adjustments` — Creates a manual forecast adjustment for `load` or `pv`.
- `PATCH /predictions/adjustments/:id` — Updates a manual forecast adjustment.
- `DELETE /predictions/adjustments/:id` — Deletes a manual forecast adjustment.
- `POST /predictions/validate` — Runs load-predictor validation against Home Assistant history.
- `POST /predictions/load/forecast` — Runs the active load forecast and returns adjusted forecast data with `rawForecast` when adjustments apply.
- `POST /predictions/pv/forecast` — Runs the PV forecast when PV configuration is complete.
- `POST /predictions/forecast` — Runs load and PV forecasts together, persists raw forecasts according to data-source settings, and returns adjusted forecasts.
- `GET /predictions/forecast/now` — Same combined forecast path with recent comparison disabled.
- `GET /ev/current` — Current time slot's EV charging decision (`ev_charge_mode`, `ev_charge_A`, source flows, EV SoC).
- `GET /ev/schedule` — Full per-slot EV charging schedule from the last computed plan.
- `GET /ha/entity/:entityId` — Fetch live entity state from Home Assistant (used to validate EV sensor configuration).
