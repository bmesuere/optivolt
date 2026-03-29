# EV departure indicators on the optimizer tab

**Date:** 2026-03-21
**Branch:** ev-settings-ha-validation

## Goal

Show the EV "ready by" departure time and target SoC on the optimizer tab — in the flows chart, SoC chart, and results table — using the same visual language already used on the EV tab.

## Scope

Four files touched, no server changes, no new settings.

---

## Changes

### `app/src/charts.js` — `drawFlowsBarStackSigned`

Add optional `evSettings` parameter after `rebalanceWindow`:

```js
export function drawFlowsBarStackSigned(canvas, rows, stepSize_m = 15, rebalanceWindow = null, evSettings = null)
```

When `evSettings?.departureTime` is set, push `makeEvDeparturePlugin(rows, evSettings.departureTime)` into the `plugins` array (alongside any rebalancing plugin). `makeEvDeparturePlugin` is already defined in the same module.

### `app/src/charts.js` — `drawSocChart`

Add optional `evSettings` parameter:

```js
export function drawSocChart(canvas, rows, _stepSize_m = 15, evSettings = null)
```

When `evSettings` is present, call `makeEvTargetPlugin(rows, evSettings.departureTime, evSettings.targetSoc_percent)` and pass the result in the `plugins` array. This renders:
- A dashed green vertical line at the departure slot
- A dashed green horizontal line at the target SoC percentage with a `%` label

### `app/src/table.js` — `renderTable`

Add optional `evSettings` to the options object:

```js
export function renderTable({ rows, cfg, targets, showKwh, rebalanceWindow, evSettings })
```

Compute `departureIdx`: find the first row where `timestampMs >= new Date(evSettings.departureTime).getTime()`. For that row:
- Add `ring-1 ring-inset ring-emerald-200 dark:ring-emerald-800/50` to the `<tr>` class
- Append a "ready" badge to the time cell (same HTML as `renderEvTable`)

### `app/main.js` — `renderAllCharts` + `renderTable` call

Read `evSettings` from DOM inputs (same as `updateEvPanel`):

```js
const evSettings = {
  departureTime: els.evDepartureTime?.value || null,
  targetSoc_percent: parseFloat(els.evTargetSoc?.value) || null,
};
```

Pass `evSettings` to:
- `renderAllCharts(rows, cfg, rebalanceWindow, evSettings)` → forwards to `drawFlowsBarStackSigned` and `drawSocChart`
- `renderTable({ ..., evSettings })`

Update `renderAllCharts` signature accordingly:

```js
function renderAllCharts(rows, cfg, rebalanceWindow = null, evSettings = null) {
  drawFlowsBarStackSigned(els.flows, rows, cfg.stepSize_m, rebalanceWindow, evSettings);
  drawSocChart(els.soc, rows, cfg.stepSize_m, evSettings);
  drawPricesStepLines(els.prices, rows, cfg.stepSize_m);
  drawLoadPvGrouped(els.loadpv, rows, cfg.stepSize_m);
}
```

---

## Visual behaviour

| Location | What's shown |
|---|---|
| Flows chart (optimizer tab) | Dashed green vertical line at departure slot, time label at top |
| SoC chart (optimizer tab) | Dashed green vertical line at departure slot + dashed green horizontal line at target SoC with `%` label |
| Results table (optimizer tab) | Green ring on departure row, "ready" badge in time cell |

All indicators are conditionally rendered — if `departureTime` is not set, nothing changes.

---

## Non-goals

- No server/API changes
- No new settings or config fields
- No changes to the EV tab (already correct)
- No changes to the prices or load/PV charts
