# Battery Balancing Implementation Plan

## Goal Description
Implement a feature to dynamically schedule a battery capacity rebalancing period. The user can manually toggle this feature via the UI in the "Algorithm" settings section. When enabled, the LP solver will be constrained to hold the battery at the target SoC (`maxSoc_percent`, typically 100%) for a contiguous window (e.g. 3 hours). The optimizer will naturally choose the cheapest sequence of time slots to perform this balancing within its lookahead horizon (MILP with binary start-position variables).

The UI will also surface whether the rebalancing is currently "Scheduled" or "Active" via the Plan Summary.

## Proposed Changes

### Configuration & State
We will extend the application settings and persistence state to support manual rebalancing.

#### [MODIFY] `api/types.ts`
- Extend `Settings` to include the manual rebalancing parameters:
  - `rebalanceEnabled`: boolean (updated via UI toggle)
  - `rebalanceHoldHours`: number (updated via UI input)
- Extend `Data` to include rebalance state:
  ```typescript
  export interface RebalanceState {
    startMs: number | null; // The timestamp when we first hit the target SoC for this cycle
  }
  ```
  Add optional field to `Data`:
  ```typescript
  rebalanceState?: RebalanceState;
  ```

#### [MODIFY] `api/defaults/default-settings.json`
- Add default values:
  ```json
  "rebalanceEnabled": false,
  "rebalanceHoldHours": 3
  ```

#### [MODIFY] `api/services/settings-store.ts`
- Add `rebalanceHoldHours` to the `NUMERIC_FIELDS` array so it gets validated.

#### [MODIFY] `lib/types.ts`
- Extend `SolverConfig` to include:
  - `rebalanceHoldSlots?: number;` — total hold duration in slots (derived from `rebalanceHoldHours / (stepSize_m / 60)`)
  - `rebalanceRemainingSlots?: number;` — slots still needed (= holdSlots when not started, countdown when active)
  - `rebalanceTargetSoc_percent?: number;` — always set to `maxSoc_percent`

#### [MODIFY] `api/services/config-builder.ts`
- In `buildSolverConfigFromSettings()`, when `settings.rebalanceEnabled`:
  - Calculate `rebalanceHoldSlots` from `rebalanceHoldHours` and `stepSize_m`.
  - Calculate `rebalanceRemainingSlots`:
    - If `data.rebalanceState?.startMs` is set: `remainingSlots = max(0, holdSlots - slotsElapsed)` where `slotsElapsed = floor((nowMs - startMs) / (stepSize_m * 60000))`.
    - If `startMs` is `null` (not started yet): `remainingSlots = holdSlots` (the full duration).
  - Set `rebalanceTargetSoc_percent = settings.maxSoc_percent`.
- Accept `data` parameter (already available) and `nowMs` (already a parameter).

### Calculation & Bookkeeping
#### [MODIFY] `api/services/planner-service.ts`
The bookkeeping logic belongs in the planner service (not the route), since it orchestrates the full pipeline.

- **Pre-solve** (in `computePlan()`):
  - If `rebalanceEnabled` and `rebalanceRemainingSlots === 0` (cycle complete):
    - Clear `data.rebalanceState.startMs` to `null`.
    - Set `settings.rebalanceEnabled = false`.
    - Save both settings and data.
    - Rebuild `cfg` without rebalance constraints for this solve.

- **Post-solve** (in `computePlan()`, after parsing the solution):
  - If `rebalanceEnabled` and `data.rebalanceState?.startMs` is `null`:
    - Check the **actual measured SoC** (`data.soc.value`) against `maxSoc_percent`.
    - If `data.soc.value >= maxSoc_percent`: the rebalancing hold has officially begun.
      Set `data.rebalanceState = { startMs: timing.startMs }` and save `data.json`.

#### [MODIFY] `api/routes/calculate.ts`
- No changes needed — the route stays a thin HTTP handler. All bookkeeping is in `planner-service.ts`.

### LP Formulation
#### [MODIFY] `lib/build-lp.ts`
- Destructure the new optional fields from `SolverConfig` (default to `undefined`/`0`).
- If `D = rebalanceRemainingSlots > 0`:
  - Convert `rebalanceTargetSoc_percent` to Wh: `targetSoc_Wh = (rebalanceTargetSoc_percent / 100) * batteryCapacity_Wh`.
  - **Binary start variables**: Introduce `start_balance_k` for `k ∈ [0, T − D]`.
  - **Exactly-one-start constraint**: `Σ_k start_balance_k = 1`.
  - **Force SoC constraints**: For every slot `t`:
    - `S(t) = Σ_{k=max(0, t-D+1)}^{min(t, T-D)} start_balance_k`
    - Constraint: `soc_t ≥ targetSoc_Wh × S(t)` (when `S(t) = 1`, SoC is forced to target; when `S(t) = 0`, constraint is non-binding).
  - Add a `Binaries` section listing all `start_balance_k` variables.
- Note: This converts the LP to a MILP. With ~80 binary variables for a typical 24h/15min horizon, HiGHS WASM handles this fine.

### Plan Summary & UI Data
#### [MODIFY] `lib/types.ts`
- Add to `PlanSummary`:
  ```typescript
  rebalanceStatus?: 'disabled' | 'scheduled' | 'active';
  ```

#### [MODIFY] `lib/plan-summary.ts`
- Extend `buildPlanSummary()` signature to accept an optional rebalance context object (e.g. `rebalance?: { enabled: boolean; startMs: number | null; remainingSlots: number }`).
- Determine `rebalanceStatus`:
  - `'active'` — if `startMs` is not null (hold period is in progress).
  - `'scheduled'` — if enabled and `startMs` is null (waiting for battery to reach target).
  - `'disabled'` — otherwise.

### Frontend
The frontend is a static web UI under `app/` with no build step. Settings are managed via `app/src/state.js` (snapshot/hydrate), `app/src/ui-binding.js` (DOM wiring), and `app/index.html` (markup).

#### [MODIFY] `app/index.html`
- In the Algorithm settings section, add:
  - A checkbox/toggle: "Schedule Battery Rebalancing" with `id="rebalance-enabled"`.
  - A number input: "Hold Duration (hours)" with `id="rebalance-hold-hours"`.

#### [MODIFY] `app/src/ui-binding.js`
- Add `rebalanceEnabled: $("#rebalance-enabled")` and `rebalanceHoldHours: $("#rebalance-hold-hours")` to `getElements()`.

#### [MODIFY] `app/src/state.js`
- In `snapshotUI()`: read `rebalanceEnabled` (checkbox `.checked`) and `rebalanceHoldHours` (number input `.value`).
- In `hydrateUI()`: set the checkbox and number input from saved settings.

#### [MODIFY] `app/src/state.js` — `updateSummaryUI()`
- Read `summary.rebalanceStatus` from the API response.
- When not `'disabled'`, render a status badge/text in the Plan Summary area (e.g. "Rebalancing: Scheduled" or "Rebalancing: Active").

#### [MODIFY] `app/index.html`
- Add a placeholder element in the Plan Summary section for the rebalance status badge (e.g. `id="rebalance-status"`).

## Verification Plan

### Automated Tests
1. **MILP LP Formatting (`tests/lib/build-lp.test.js`)**:
   - Verify that when `rebalanceRemainingSlots > 0` (and `rebalanceTargetSoc_percent` set), the LP output contains a `Binaries` block with `start_balance_k` variables.
   - Verify the `Σ start_balance_k = 1` constraint is present.
   - Verify per-slot SoC forcing constraints reference the correct `targetSoc_Wh`.
   - Verify binary variables range is `[0, T − D]`.
   - Verify that when `rebalanceRemainingSlots` is 0 or undefined, no binary variables appear (pure LP).

2. **MILP Solving Logic**:
   - Pass a config with `rebalanceRemainingSlots = 12` (3h at 15min) to `buildLP`, solve with HiGHS, parse the solution.
   - Verify the solution contains a contiguous block of 12 slots where `soc_percent ≈ maxSoc_percent`.
   - Verify the solver places this block during cheapest-energy periods.

3. **Config Builder (`tests/api/services/config-builder.test.js`)**:
   - **Not started**: `rebalanceEnabled = true`, `startMs = null` → `rebalanceRemainingSlots = holdSlots`.
   - **Mid-cycle**: `startMs` 30 min ago, `holdSlots = 12` → `rebalanceRemainingSlots = 10`.
   - **Completed**: `startMs` far enough ago → `rebalanceRemainingSlots = 0`.

4. **Planner Service Bookkeeping (`tests/api/services/planner-service.test.js`)**:
   - **Starting a cycle**: `rebalanceEnabled = true`, `startMs = null`, `data.soc.value >= maxSoc_percent` → verify `startMs` gets set and saved.
   - **Not yet at target**: `rebalanceEnabled = true`, `startMs = null`, `data.soc.value = 50` → verify `startMs` remains null.
   - **Completing a cycle**: `rebalanceRemainingSlots = 0` → verify `rebalanceEnabled` set to false, `startMs` cleared, both saved.

### Manual/Integration Verification
1. **Regression**: `npm test` passes with no regressions when rebalancing is disabled.
2. **Frontend Integration**:
   - Boot local server, open the UI.
   - In the Algorithm section, toggle "Schedule Battery Rebalancing" on, set Hold Duration to 2 hours.
   - Hit "Calculate".
   - Verify Plan Summary shows "Rebalancing: Scheduled".
   - When actual SoC reaches 100%, hit "Calculate" again → Summary shows "Rebalancing: Active".
   - After the hold duration elapses → rebalance auto-disables, summary shows nothing.
   - Verify the SoC chart shows the battery held at 100% for the rebalancing window.
