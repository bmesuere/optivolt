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

## Phase 1 — Server data plumbing (this branch)

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
- Timestamps in `forecast.json` are Brussels wall-clock; parsed with an
  explicit `Europe/Brussels` timezone conversion (Intl-based, DST-safe), with
  ISO-with-offset timestamps also accepted should the feed ever add them.
- The `min()` horizon rule in `config-builder.ts` stays: with all four series
  extended it yields the requested horizon and remains the safety net when a
  source falls short.

## Phase 2 — Solver & EV review (this branch)

- EV targets need no new code: entries beyond the old horizon stop being
  filtered by `ev-config-builder.ts` once the horizon covers them (covered by
  a regression test).
- Rebalancing: `rebalanceMaxStartSlot` restricts `start_balance_k` to day-1
  slots on extended horizons, so "hold once" keeps its current meaning (and
  the binary count is capped at one day's worth). Standard horizons are
  untouched.
- Symmetry-break penalties verified at 384 slots: the largest escalating
  coefficient (1e-6 × 384 = 3.84e-4 c€) stays an order of magnitude below the
  smallest real cost coefficient (~2.5e-3 c€ per W at 10 c€/kWh), and far
  above solver tolerance.
- Synthetic 4-day solve benchmark (M-series Mac, WASM HiGHS, gap 0.5%):
  LP-only 0.13 s, EV binaries 0.55 s, rebalance capped 3.1 s,
  EV + rebalance capped 18.5 s (uncapped 25.8 s; 7.5 s at gap 2%). All
  Optimal within the 30 s limit — but EV × rebalance on a 4-day horizon is
  the combination to watch on slower hardware; fallbacks if the phase-4
  shadow period shows timeouts: loosen the MIP gap for large horizons, or
  coarsen far-out slots.

## Phase 3 — Dashboard (this branch)

- `/calculate` exposes `pricesKnownUntilMs`; the prices chart dashes the line
  beyond it (`segment.borderDash`), shades the forecast zone, and marks
  forecast slots in the tooltip.
- View-range toggle "Standard | Full horizon" on the Power flows card, shown
  only when the plan extends past the standard day-ahead window; defaults to
  Standard (unchanged UX) and persists in localStorage.
- Power-flows bars aggregate to hourly in views spanning > 48 h (energy-
  preserving means; prices averaged, costs summed, SoC last-of-hour), with a
  15 min/1 h toggle; auto-selects 1 h, the user's explicit choice persists.
  The load/PV chart was already hourly; SoC and prices stay per-slot lines.
- Multi-day EV annotations verified: markers already skip out-of-range times,
  so they appear in the full view and vanish in Standard.
- Schedule table groups days after the first into collapsible day sections on
  views spanning > 48 h; the standard layout is untouched.

## Phase 4 — Validation (this branch)

- Unit tests for merge priority, the leading-gap guard, horizon settings,
  multi-day EV targets, and the day-1 rebalance restriction shipped with
  phases 0–3. This phase adds a full-pipeline integration test: persisted
  data with a forecast price tail → config-builder merge → LP → a real HiGHS
  solve → parsed rows, asserting the merged horizon, `pricesKnownUntilMs`,
  and that a 3-days-out EV target is actually met.
- Guardrail from the phase-2 benchmark: the EV × rebalance combination on a
  multi-day horizon loosens `mip_rel_gap` from 0.5% to 2% (18.5 s → 7.5 s on
  the benchmark), so slow hardware degrades to a slightly-less-optimal plan
  instead of a timed-out solve — which would block hardware writes every
  cycle. All other solves keep the tight gap. The gap is included in the
  `[calculate] solve` log line for the shadow period.
- Remaining (operational): shadow period — run `extendedHorizonDays: 3` with
  calculation only (`writeToVictron: false`), watching `solveMs`, `status`,
  and `mipRelGap` in the logs before enabling writes.
