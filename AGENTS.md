# Optivolt agent guide

## Front-end layout
- The public web app lives in the `app/` directory. `main.js` is the module entry point and re-exports logic from `app/scr/`.
- Runtime behaviour (local solver vs API solver) is controlled via `app/runtime-config.js`. Do not hard-code alternative entry points—extend the config switch instead.
- Persisted UI settings must stay compatible with `DEFAULTS` in `app/scr/config.js`. Use `snapshotUI()` when saving browser settings so the `_txt` fields remain strings.
- The `app/lib/` folder is generated via `npm run prepare` for GitHub Pages deploys; keep it out of version control.

## API
- When changing API endpoints, keep the request/response contracts in sync with the browser client. `/calculate` accepts `{ config, timing }` and returns `{ status, objectiveValue, rows, timestampsMs }`.
- `/settings` stores plain JSON snapshots from the browser. Maintain backwards compatibility when updating the schema.

## PR / testing notes
- Prefer small, focused commits with descriptive messages.
- Run `npm test` or relevant integration checks when modifying solver or API behaviour. Document executed commands in the final summary.
