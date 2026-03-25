# EV Charging Support — Revised Plan

## Context

OptiVolt currently optimizes battery/grid flows but has no awareness of EV charging. The EV charger sits behind the Victron inverter. The goal is to add **planned charging** — "charge to X% by time Y" — as an LP-integrated feature.

**Key simplification vs. original plan:** Realtime surplus charging (diverting PV excess to EV) is handled entirely in Home Assistant. OptiVolt only handles *planned* charging via the LP solver.

**Prior work (not merged):** An `ev-support` branch implemented Phases 1-4 of the original plan (settings, heuristic schedule, API endpoints, UI tab). That branch is abandoned but contains reusable code patterns for types, HA REST client, and settings UI.

**Key constraints:**
- HA controls the physical charger (OptiVolt only plans)
- HA provides: EV SoC, plug status via entity states
- OptiVolt fetches EV state from HA (like it fetches VRM data)
- Charger is behind inverter → EV charging affects grid import/export balance
- EV charge power is continuous between configurable min/max current (× 230V)

---

## Phase 1: EV Settings & HA Entity Validation

**Goal:** Add EV configuration to the settings page with live HA entity validation.

### Settings additions (`api/types.ts` → `Settings`):
- `evEnabled: boolean`
- `evMinChargeCurrent_A: number` — minimum charge current (× 230V = min power)
- `evMaxChargeCurrent_A: number` — maximum charge current (× 230V = max power)
- `evBatteryCapacity_kWh: number` — EV battery capacity
- `evSocSensor: string` — HA entity ID for EV battery SoC
- `evPlugSensor: string` — HA entity ID for plug/charger connected status

### HA entity validation:
- New `fetchHaEntityState()` REST API function in `ha-client.ts`
- New `/ha/entity/:entityId` proxy route for browser to validate entities
- On sensor input blur: save settings → fetch entity state → show current value or error

### UI (Settings tab):
- "EV Charging" card with: enable toggle, charge current, battery capacity, sensor entity IDs with live value indicators

### Key files:
- `api/types.ts`, `api/defaults/default-settings.json`, `api/services/settings-store.ts`
- `api/services/ha-client.ts` — new `fetchHaEntityState()`
- `api/routes/ha.ts` — new route file
- `api/app.ts` — mount `/ha` route
- `app/index.html` — EV settings card
- `app/src/ui-binding.js`, `app/src/state.js`, `app/main.js` — UI wiring
- `app/src/api/api.js` — browser API function

---

## Phase 2: LP Integration — Planned Charging

**Goal:** "Charge to X% by time Y" — optimizer decides *when* to charge.

### Settings additions:
- `evDepartureTime: string` — target departure time (HH:MM)
- `evTargetSoc_percent: number` — desired SoC at departure
- `evReimbursement_cents_per_kWh: number` — employer reimbursement rate (optional)

### LP changes:
New flow variables following the `{source}_to_{sink}` pattern: `grid_to_ev_t`, `pv_to_ev_t`, `battery_to_ev_t`. These appear as additional sinks in the energy balance:
```text
g2l + g2b + g2ev = grid_import_t
pv2l + pv2b + pv2g + pv2ev = pv_W[t]
b2l + b2g + b2ev = discharge_t
```

Total EV power per slot: `ev_t = g2ev_t + pv2ev_t + b2ev_t`, bounded by `[minPower_W, maxPower_W]` when charging is active (binary variable for on/off, continuous for power level between min and max).

EV SoC tracking with hard constraint at departure slot.

### Key files:
- `lib/types.ts` — `SolverConfig`: `evEnabled`, `evChargePower_W`, `evAvailable`, etc.
- `lib/build-lp.ts` — `ev_charge_t` variable + constraints
- `lib/parse-solution.ts` — Extract `ev_charge_t`
- `api/services/config-builder.ts` — Build EV config from settings + data

---

## Phase 3: EV UI in Optimizer

**Goal:** Display EV charging in charts, table, and summary.

- EV bar series in power flows chart
- EV column in plan table
- EV totals in plan summary

---

## Phase 4: EV Tab & API Endpoints

**Goal:** Dedicated EV tab and HA-pollable endpoints.

- `GET /ev/schedule`, `GET /ev/current` for HA polling
- EV tab: status card, schedule chart, schedule table

---

## Implementation order

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | EV settings + HA entity validation | **Done** |
| 2 | LP integration (planned charging) | **Done** |
| 3 | EV in optimizer charts/table/summary | **Done** |
| 4 | EV tab + API endpoints | **Done** |

---

## Open questions
- **V2G (vehicle-to-grid):** Not in scope
- **Multiple EVs:** Future consideration
- **Variable charge rate:** LP supports continuous between min/max current; charger hardware may only support discrete steps
- **Home battery priority:** May need `evMinHomeSoc_percent` constraint to ensure home battery charges first
