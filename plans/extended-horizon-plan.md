# Extended planning horizon

Extend the plan window from the current ~12–36 h (bounded by the VRM day-ahead
window) to a configurable multi-day horizon, so long-range EV targets ("80% in
3 days") become real LP constraints instead of manually staged intermediate
targets.

## Decisions

- **Opt-in setting** `extendedHorizonDays: 0–6`, default `0` = today's
  behaviour exactly. Resource-constrained devices are unaffected unless they
  opt in. A `priceForecastUrl` setting (default empty) enables the forecast
  price source.
- **15-minute slots for the whole horizon.** ~384 slots at 4 days. Coarser
  far-out slots are a documented fallback if solve times become a problem, not
  built now.
- **Real prices always win.** Forecast values only fill slots beyond the end of
  the actual price series.
- **Forecast prices are stored as separate series** and merged at solve time —
  actuals keep their existing owner and transport (HA push via `POST /data`, or
  VRM pull), while optivolt itself pulls predictions from `priceForecastUrl`
  during the `/calculate` update step. Pushing predictions through HA would hit
  HA's ~16 KB attribute limit and adds automation plumbing for no benefit.

The forecast source is <https://energie.bartm.be/forecast.json> (built in the
`energieprijs` repo from the hosted EpexPredictor API): 15-minute Belgian spot
prices ~7 days ahead with the Ecopower formulas applied, plus a `known_until`
timestamp separating published day-ahead prices from model predictions.

## Phase 0 — Safety groundwork (this branch)

- **Leading-gap guard** in `config-builder.ts`: `extractWindow` zero-pads slots
  a series doesn't cover. Zero PV is legitimate (no sun yet); zero load or
  prices would let the solver plan against free energy. Load and price series
  that start after the plan window now fail with a 422 instead.
- **Solver time limit**: pass `time_limit` to HiGHS so a degenerate MILP can't
  block the (synchronous) event loop indefinitely. A limited solve returns a
  non-Optimal status and is already refused for hardware writes.
- `status` added to the `[calculate] solve` log line.

## Phase 1 — Server data plumbing

- Settings: `extendedHorizonDays` (0 = off), `priceForecastUrl`.
- New `price-forecast-service.ts`: fetch and parse `forecast.json`
  (`consumption_data` → import, `injection_data` → export), persist as
  `data.importPriceForecast` / `data.exportPriceForecast`. On fetch failure
  keep the previous forecast; the horizon then shrinks gracefully as it ages.
- `config-builder.ts`: merge actual + forecast per price series — actual values
  win wherever both exist, forecast extends the tail. Expose the merge boundary
  (`pricesKnownUntilMs`) for the UI and diagnostics.
- Load: extend `getForecastTimeRange` (`lib/time-series-utils.ts`) by
  `extendedHorizonDays`; the historical predictor itself is unbounded.
- PV: replace the hardcoded `forecastDays: 2` in `open-meteo-client.ts` with
  `extendedHorizonDays + 2` (Open-Meteo serves up to 16). For `pv: 'vrm'`,
  extend `windowOptimizationHorizon` (`lib/vrm-api.ts`) the same way and clamp
  to what VRM returns.
- Timestamps in `forecast.json` are Brussels wall-clock; either parse with an
  explicit timezone or add UTC timestamps to the feed first (preferred).
- The `min()` horizon rule in `config-builder.ts` stays: with all four series
  extended it yields the requested horizon and remains the safety net when a
  source falls short.

## Phase 2 — Solver & EV review

- EV targets need no new code: entries beyond the old horizon stop being
  filtered by `ev-config-builder.ts` once the horizon covers them.
- Rebalancing: restrict `start_balance_k` to day-1 slots so "hold once" keeps
  its current meaning over a multi-day horizon (and caps that binary count).
- Verify the escalating symmetry-break penalties (`build-lp.ts`) stay
  numerically sane at ~384 slots.

## Phase 3 — Dashboard

- Dashed price line beyond `pricesKnownUntilMs` (Chart.js `segment.borderDash`)
  plus a shaded "forecast zone" background.
- View-range toggle "Standard | Full horizon", defaulting to Standard so the
  default UX is unchanged; persisted client-side.
- Hourly aggregation for bar charts in the full-horizon view (sum energy,
  average power), with a 15 min/1 h toggle; auto-select 1 h beyond ~48 h.
- Verify multi-day EV annotations (previously skipped beyond the horizon) and
  add day-collapsible sections to the table.

## Phase 4 — Validation

- Unit tests: merge priority, leading-gap guard, horizon setting variations,
  multi-day EV targets/windows, day-1 rebalance restriction.
- Synthetic 4-day solve benchmark before relying on the MILP at ~384 slots.
- Shadow period: run `extendedHorizonDays: 3` with calculation only (no
  hardware writes) comparing `solveMs` and plan quality.
