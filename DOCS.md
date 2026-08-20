# Home Assistant Add-on: Optivolt

Plan and control a Victron ESS with forecasts and dynamic tariffs.

## About

Optivolt builds a day-ahead plan for your home energy system. Every 15 minutes
it takes your consumption forecast, PV forecast and electricity prices, and
solves a cost-minimizing schedule for the battery, the grid, and (optionally)
an EV charger. The first four slots of that schedule can be pushed to your
Victron system as a Dynamic ESS schedule over MQTT, so the hardware actually
follows the plan.

The add-on serves its own web UI through Home Assistant ingress, so no port
needs to be exposed to use it.

## Installation

1. Install the **Samba share** add-on and make the `/addons` directory
   available as a network share, then mount it on your computer.
2. Copy the contents of the Optivolt repository into `addons/optivolt` on that
   share.
3. Go to **Settings → Add-ons → Add-on Store**, check for updates, find
   **Optivolt** in the local add-ons section and install it.
4. Fill in the configuration options below.
5. Start the add-on and open the UI from the sidebar.

## Configuration

All options are set in the add-on's **Configuration** tab.

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `site_id` | yes | – | Your Victron VRM installation ID (also called *idSite*), visible in the VRM URL: `…/installations/<idSite>/…`. |
| `vrm_token` | yes | – | A VRM Personal Access Token, created under **Preferences → Integrations** in VRM. |
| `mqtt_host` | no | `venus.local` | Hostname or IP address of the Victron MQTT broker (your Venus OS / Cerbo device). |
| `mqtt_port` | no | `1883` | Port of the Victron MQTT broker. |
| `mqtt_username` | no | empty | MQTT username, if your broker requires one. |
| `mqtt_password` | no | empty | MQTT password, if your broker requires one. |

MQTT is only needed to write schedules to the Victron system. Without it,
Optivolt still fetches data and computes plans, but cannot control hardware.

Make sure MQTT is enabled on the Venus OS device: open the remote console and
go to **Settings → Services → MQTT**.

Historical sensor data is read from Home Assistant automatically using the
add-on's supervisor token; no URL or token has to be configured for that.

## Network

The UI is reached through ingress from the Home Assistant sidebar. The add-on
also maps its HTTP API to host port `3070` so Home Assistant automations can
call it directly. That API is unauthenticated, so anything on your LAN can
reach it — clear the port mapping in the add-on's **Network** configuration if
you do not need direct access.

## Using the web UI

The UI has four tabs:

- **Optimizer** — the current plan: charts of load, PV, grid flows, battery
  SoC and prices, plus the per-slot schedule table. **Recompute** solves a new
  plan on demand. Quick settings next to the charts let you change the most
  used solver knobs without leaving the tab.
- **EV** — EV charging configuration (charger limits, battery capacity) and
  the planned charging schedule, including availability windows and SoC
  targets for upcoming departures.
- **Predictions** — configuration for the load and PV forecasters, a
  validation run that scores predictor settings against your own history, and
  a forecast chart where you can draw manual adjustments (for example, "we're
  away this weekend").
- **Settings** — system limits, algorithm options, and the data sources for
  load, PV, prices and SoC. Each series is either owned by the VRM refresh
  (`vrm`) or written by you through the API (`api`).

Settings and forecasts are stored inside the add-on's `/data` directory and
survive restarts and updates.

## Automating from Home Assistant

Optivolt does not run on a timer by itself; Home Assistant triggers it.

Add a REST command that recomputes the plan and writes it to Victron:

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

Then call it a few seconds after every quarter hour:

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

To keep load and PV forecasts fresh, call `GET /predictions/forecast/now`
periodically as well, after configuring the predictors on the Predictions tab.

To drive an EV charger, poll `GET /ev/current` and expose the result as REST
sensors; `ev_charge_mode` (`off`, `fixed`, `solar_only`, `solar_grid`, `max`)
and `ev_charge_A` tell you what the charger should be doing right now.

Full examples, including pushing your own price data, are in the project
[README](https://github.com/bmesuere/optivolt#readme).

## Victron Dynamic ESS

Set Victron's own Dynamic ESS to **Node-RED** mode so it does not overwrite
Optivolt's schedule.

There is a known Victron API bug where price data is not returned unless
Dynamic ESS is in its default mode. The usual workaround is a Home Assistant
automation that flips it back to default between 13:00 and 14:00 each day, so
the next day's prices get fetched, and returns it to Node-RED afterwards.

Only the first four slots of a plan are ever written to the hardware; a longer
horizon changes *today's* decisions without changing what gets pushed.

## Support

Report problems on the
[issue tracker](https://github.com/bmesuere/optivolt/issues). Add-on logs are
available under the add-on's **Log** tab.
