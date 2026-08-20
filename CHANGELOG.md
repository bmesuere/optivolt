# Changelog

Coarse release notes for the Optivolt Home Assistant add-on, reconstructed
from the merged pull requests behind each `config.yaml` version bump. The
project is not tagged and the version is bumped rarely, so each entry covers
the period it was the current version rather than a single release date, and
groups work rather than listing every change.

## 0.2.0 — 2026-02-22 onwards

Still the current version; everything below has shipped under it.

- **Deprecated:** `rows[*].soc` in the `/calculate` responses is renamed to
  `soc_Wh` (it always held watt-hours). `soc` is still emitted with the same
  value as a compatibility alias and will be removed in a future version —
  migrate external automations to `soc_Wh`.

- Load forecasting from Home Assistant sensor history, with pluggable
  predictors and a fixed-load fallback.
- PV forecasting from Open-Meteo weather data, including a linear irradiance
  model and daily accuracy reporting.
- EV charging is planned by the solver: availability windows, SoC targets and
  expected arrival, plus `/ev/current` and `/ev/schedule` for charger control.
- Optional extended planning horizon of up to six extra days, using forecast
  prices beyond the published day-ahead window.
- Periodic battery rebalancing: a scheduled window that charges the pack to
  full, with a nudge when a full-SoC observation is missed.
- Manual forecast adjustments, drawn directly on the prediction chart and
  applied on top of the raw persisted forecasts.
- Reworked UI: pinnable optimizer quick settings, consolidated settings tab,
  schedule-table totals, and dark-mode polish.
- Solving moved onto a worker thread; front-end dependencies are vendored so
  the add-on works without internet access.
- Server and core logic migrated to TypeScript, run directly by Node's type
  stripping.

## 0.1.0 — 2025-10-19 to 2026-02-21

- Initial Home Assistant add-on packaging, served through ingress
  (added 2025-11-11; the weeks before that were the pre-add-on prototype).
- Day-ahead cost minimization over 15-minute slots with the HiGHS solver,
  covering battery, PV, grid and load.
- Victron VRM integration for forecasts, prices, system limits and live SoC.
- Dynamic ESS schedule writing over MQTT to a local Venus OS device.
- Home Assistant integration for historical sensor data.
- Custom time-series push via the `/data` endpoint for non-VRM price sources.
- Static web UI with schedule table and plan charts.
