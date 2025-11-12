# Optivolt agent guide

## Front-end layout
- The public web app lives in the `app/` directory. `main.js` is the module entry point and re-exports logic from `app/scr/`.
- The browser talks to the Express API through helpers in `app/scr/api/`. Reuse `client.js` for shared request/response handling and group endpoint-specific helpers (e.g. settings, solver, VRM proxy) into separate modules there.
- Persisted UI settings must stay compatible with the server defaults defined in `lib/default-settings.json`. Use `snapshotUI()` when saving browser settings so the `_txt` fields remain strings.

## API
- When changing API endpoints, keep the request/response contracts in sync with the browser client. `/calculate` accepts `{ config, timing }` and returns `{ status, objectiveValue, rows, timestampsMs }`.
- `/settings` stores plain JSON snapshots from the browser. Maintain backwards compatibility when updating the schema.

## PR / testing notes
- Prefer small, focused commits with descriptive messages.
- Run `npm test` or relevant integration checks when modifying solver or API behaviour. Document executed commands in the final summary.
