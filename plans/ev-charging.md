# EV Charging Support — Long-term Incremental Plan

## Context

OptiVolt currently optimizes battery/grid flows but has no awareness of EV charging. The EV charger sits behind the Victron inverter but is excluded from load predictions and controlled entirely via Home Assistant. The goal is to incrementally add EV charging intelligence — starting with simple "charge instead of export" heuristics, building toward full LP-integrated optimization with departure targets.

**Key constraints:**
- HA controls the physical charger (OptiVolt only plans)
- HA can provide: EV SoC, plug status, max charge power (via entity states)
- OptiVolt fetches EV state from HA (like it fetches VRM data), not the other way around
- OptiVolt exposes endpoints for HA to poll charging decisions
- Charger is behind inverter → EV charging affects grid import/export balance
- EV charge power is a fixed user-configurable value (binary on/off, not modulated)

---

## Phase 0: Settings Tab (UI refactor)

**Goal:** Add a third "Settings" tab to the header. Consolidate configuration that rarely changes:
- **From Optimizer tab:** System settings card (`#card-system`) — battery params, grid limits, efficiencies, data sources, algorithm
- **From Predictions tab:** HA connection settings (WebSocket URL, token) and sensor configuration (sensors JSON, derived JSON)

The Optimizer sidebar keeps only: algorithm settings (terminal SoC, rebalancing), run toggles, recompute button, and plan summary. The Predictions sidebar keeps only: prediction-specific controls (sensor selector, lookback, aggregation, filter), recompute, summary, and comparison runner.

### Key files:
- `app/index.html` — Add third tab button, create `panel-settings`, relocate cards
- `app/main.js` — Handle third tab in tab-switching logic
- `app/src/state.js` — Element IDs stay the same (just moved in DOM), no changes needed

---

## Phase 1: EV Data Layer & Settings

**Goal:** Add EV configuration, fetch EV state from HA, persist alongside existing data.

### Settings additions (`api/types.ts` → `Settings`):
- `evEnabled: boolean`
- `evChargePower_W: number` — fixed user-configurable charge power
- `evChargeEfficiency_percent: number`
- HA entity IDs for EV (SoC sensor, plug binary_sensor — stored in settings)

### Data additions (`api/types.ts` → `Data`):
- `evState?: { soc_percent: number; plugged: boolean; maxPower_W: number; timestamp: string }`

### Data source: `dataSources.ev: 'ha' | 'api' | 'none'`

### HA fetch:
- Add `fetchHaEntityStates()` to `api/services/ha-client.ts` (REST API — simpler than WebSocket for one-shot state reads; HA URL + token already configured in settings)
- Call during data refresh when `dataSources.ev === 'ha'`

### UI (in Settings tab from Phase 0):
- EV section: enable toggle, charge power, efficiency, HA entity IDs

### Key files:
- `api/types.ts`, `api/defaults/default-settings.json`, `api/services/settings-store.ts`, `api/services/data-store.ts`
- `api/services/ha-client.ts` — new `fetchHaEntityStates()`
- `api/services/vrm-refresh.ts` or new `ev-refresh.ts` — fetch + persist EV state
- `app/index.html` — EV settings UI in Settings tab

---

## Phase 2: Heuristic EV Charging Schedule

**Goal:** Post-solve, identify slots where energy would be exported to grid. Generate binary on/off EV charging schedule.

### Logic:
For each slot: if `evEnabled && plugged && pv2grid > 0` → charge at configured `evChargePower_W`.
Only PV-to-grid surplus triggers EV charging — battery-to-grid exports are intentionally excluded since those may be lucrative grid injections the user wants to keep.

### Key files:
- **New: `lib/ev-schedule.ts`** — Pure function `buildEvSchedule()` → `EvSlot[]`
- `lib/types.ts` — `EvSlot` type: `{ timestampMs, chargePower_W, shouldCharge }`
- `api/services/planner-service.ts` — Call after parse, include in result
- `api/routes/calculate.ts` — Include in response
- **Tests** for pure `buildEvSchedule` function

---

## Phase 3: API Endpoint for HA

**Goal:** Expose EV decisions for HA to poll.

### Routes (`api/routes/ev.ts`):
- `GET /ev/schedule` — Full EV schedule from latest plan
- `GET /ev/current` — Current slot: `{ shouldCharge, chargePower_W }`

Cache latest EV schedule in planner service after each plan run.

### HA integration example:
```yaml
rest:
  - resource: http://optivolt:3000/ev/current
    scan_interval: 300
    sensor:
      - name: "OptiVolt EV Charge"
        value_template: "{{ value_json.shouldCharge }}"
```

---

## Phase 4: UI — Show EV in Plan

**Goal:** Display EV charging in charts, table, and summary.

### Key files:
- `app/src/charts.js` — EV bar series in power flows chart
- `app/src/table.js` — EV column
- `lib/plan-summary.ts` — EV totals (kWh, charging slot count)
- `app/src/state.js` — EV summary display

---

## Phase 5: LP Integration — EV as Controllable Load

**Goal:** Optimizer decides *when* to charge, considering prices + PV + battery holistically.

### Approach:
New decision variable `ev_charge_t` added to the load side of the energy balance:
```
g2l + pv2l + b2l = load_W[t] + ev_charge_t
```
This naturally shares grid import limits with household load. Optimizer can charge during cheap grid periods too, not just PV surplus.

### Reimbursement & priority setting:
The user's employer reimburses EV charging at a fixed rate (often above cost). Naively, this makes EV charging always "profitable" and the optimizer would prioritize it over everything. To prevent this:
- **Setting: `evMinHomeSoc_percent`** — Home battery must reach this SoC before EV charging is allowed. Implemented as an LP constraint: `ev_charge_t <= M * z_t` where `z_t` is 1 only when `soc_t >= evMinHomeSoc_Wh`. This ensures the home battery is charged to a comfortable level before diverting energy to the EV.
- **Setting: `evReimbursement_cents_per_kWh`** — The reimbursement rate, used as a negative cost (revenue) in the objective function for EV charging. Combined with the priority constraint, the optimizer will: (1) first fill home battery to the threshold, (2) then opportunistically charge the EV at the best times.

### Key files:
- `lib/types.ts` — `SolverConfig`: `evEnabled`, `evChargePower_W`, `evAvailable: boolean[]`, `evMinHomeSoc_percent`, `evReimbursement_cents_per_kWh`
- `lib/build-lp.ts` — `ev_charge_t` variable + constraints + priority logic
- `lib/parse-solution.ts` — Extract `ev_charge_t`
- `lib/ev-schedule.ts` — Now reads from LP solution instead of heuristic
- `api/services/config-builder.ts` — Build EV availability array

---

## Phase 6: Planned Charging — Departure Targets

**Goal:** "Charge to X% by time Y"

### Changes:
- Settings: `evDepartureTime`, `evTargetSoc_percent`, `evCapacity_Wh`
- `lib/build-lp.ts`: EV SoC tracking + hard constraint at departure slot
- UI: Departure time picker + target SoC slider

---

## Implementation order

| Phase | Scope | Depends on |
|-------|-------|------------|
| 0 | Settings tab UI refactor | — |
| 1 | EV data layer + HA fetch | Phase 0 (for UI) |
| 2 | Heuristic EV schedule | Phase 1 |
| 3 | HA polling endpoint | Phase 2 |
| 4 | EV in charts/table/summary | Phase 2 |
| 5 | LP integration | Phase 1 (replaces Phase 2) |
| 6 | Departure targets | Phase 5 |

Phases 3 and 4 can run in parallel.

---

## Open questions for future phases
- **V2G (vehicle-to-grid):** Not in initial scope
- **Push to HA:** OptiVolt calling HA REST API to set entities directly
- **Multiple EVs:** Future consideration
- **DESS interaction:** EV charging changes effective load seen by Victron — monitor if DESS mapper needs adjustment
- **Variable charge rate:** Currently fixed power; could modulate current in future
- **evMinHomeSoc as MILP:** The home-battery-first constraint may need binary variables (MILP) to properly model "SoC >= X% before EV charges". Alternative: simpler heuristic where we just set a high EV charging cost that only becomes attractive after battery is near full. Worth prototyping both.
