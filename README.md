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
  - `POST /data` — inject custom time-series data. Used when data sources in the UI are set to "API".

    The payload can contain one or more of the following keys:
    - **Prices:** `importPrice`, `exportPrice` (cents/kWh)
    - **Power:** `load`, `pv` (Watts)
    - **State:** `soc` (Percentage, object with `value` and `timestamp`)

    **Example payload:**
    ```json
    {
      "importPrice": {
        "start": "2024-01-01T00:00:00.000Z",
        "step": 15,
        "values": [10.5, 11.2, 12.0, 11.8]
      },
      "load": {
        "start": "2024-01-01T00:00:00.000Z",
        "step": 15,
        "values": [500, 450, 600, 550]
      }
    }
    ```
  - `POST /vrm/refresh-settings` — fetch latest Dynamic ESS limits/settings from VRM and persist.
- Data (forecasts, prices, SoC) are server-owned: VRM refreshes write to `DATA_DIR/data.json` (defaulting to `api/defaults/default-data.json`) and the solver always reads from this persisted snapshot.
- Shared logic lives in **`lib/`** (LP builder/parser, DESS mapping, VRM + MQTT clients).

```text
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

## Installing Optivolt in Home Assistant

This section explains how to install and wire up the Optivolt add-on in Home Assistant.

### 1. Expose the add-on directory over Samba

1. Install the **Samba share** add-on in Home Assistant.
2. Configure it so that the `/addons` (or `addons/`) directory is available as a network share.
3. From your laptop/desktop, mount that share. In this example, it is mounted as `/Volumes/addons`.

### 2. Copy the Optivolt files into Home Assistant

On your development machine, copy the contents of your local Optivolt repository into the mounted `addons` share.

Example (macOS / Linux):

```bash
rsync -av --delete \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude '.DS_Store' \
  ~/Code/optivolt/ /Volumes/addons/optivolt/
```

This will sync your local `~/Code/optivolt` directory into the `optivolt` add-on directory on Home Assistant, while skipping development artefacts.

### 3. Install the Optivolt add-on in Home Assistant

1. Go to **Settings → Add-ons → Add-on Store**.
2. Use the menu to **reload** local add-ons if necessary.
3. Find the **Optivolt** add-on in the list and click **Install**.

### 4. Configure VRM and Victron connection settings

Open the Optivolt add-on configuration panel and enter:

- Your **Victron VRM** credentials / installation ID.
- The **Victron IP address** on your local network.

Save the configuration.

### 5. Start the add-on and verify data

1. Start the Optivolt add-on.
2. Open the Optivolt UI (from the add-on page).
3. Verify that data is being fetched correctly (time series, prices, SoC, etc.). If data does not load, check the logs of the add-on.

### 6. Trigger Optivolt every 15 minutes from Home Assistant

Optivolt exposes a `/calculate/` HTTP endpoint that you can call periodically from Home Assistant.

First, define a `rest_command` in your Home Assistant configuration:

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

Then, create an automation that calls this command every 15 minutes, a few seconds after each quarter hour (to align with the quarter-hour slots):

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

Adjust the trigger as needed if you want a specific offset (e.g. 00:00:05, 00:15:05, ...).

### 7. Put DESS into Node-RED mode

To prevent Victron DESS from overwriting the settings that Optivolt writes, set DESS to **Node-RED** mode.

I used the Home Assistant **Victron MQTT extension** to switch DESS into Node-RED mode.

### 8. Work around the Victron price API bug

There is a bug in the Victron API: the **price data is not available** when DESS is *not* in the default mode. To work around this:

- Create a Home Assistant automation that temporarily sets DESS to **default** mode between **13:00 and 14:00** every day.
- During that window, price data is available and can be fetched; outside of it, DESS can be left in Node-RED mode so Optivolt fully controls the schedule.

Once all these steps are in place, Optivolt should run as an add-on, keep its data and schedules up to date, and continuously steer your Victron system using the optimized plan.
