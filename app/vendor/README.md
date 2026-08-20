# `app/vendor/` — vendored front-end dependencies

Everything the UI in `app/` needs from third parties is committed here and served
from the same origin as the app. A Home Assistant add-on may well run on a LAN
with no internet access, so the UI must not depend on any CDN at runtime.

These files are third-party or generated output: they are excluded from ESLint
(`eslint.config.js`) but they **are** committed to git.

| File | Version | Replaces |
| --- | --- | --- |
| `tailwind.css` | tailwindcss 3.4.19 | `https://cdn.tailwindcss.com` (Play CDN) |
| `chart.umd.js` | chart.js 4.5.1 | `https://cdn.jsdelivr.net/npm/chart.js@4` |
| `patternomaly.min.js` | patternomaly 1.3.2 | `https://cdn.jsdelivr.net/npm/patternomaly@1.3.2/dist/patternomaly.min.js` |
| `fonts/` | Outfit v15, JetBrains Mono v24 | `https://fonts.googleapis.com/css2?family=Outfit…` |

## Licenses

Redistributing these files requires shipping their upstream license texts,
which live in `licenses/`:

| Vendored file | License | Notice file |
| --- | --- | --- |
| `tailwind.css` | MIT | `licenses/tailwindcss.LICENSE.txt` |
| `chart.umd.js` | MIT | `licenses/chartjs.LICENSE.md` |
| `patternomaly.min.js` | MIT | `licenses/patternomaly.LICENSE.txt` |
| `fonts/outfit-*.woff2` | OFL-1.1 | `licenses/outfit.OFL.txt` |
| `fonts/jetbrains-mono-*.woff2` | OFL-1.1 | `licenses/jetbrains-mono.OFL.txt` |

When bumping a vendored version, refresh its notice file from the matching
upstream tag alongside it.

## Regenerating

### Tailwind

The Play CDN (`cdn.tailwindcss.com`) compiled the stylesheet in the browser and
is explicitly not meant for production. It is replaced by a one-time CLI build.
The theme extensions and `darkMode: "class"` that used to sit in an inline
`tailwind.config = {…}` block in `index.html` now live in `tailwind.config.js`
at the repo root.

Rerun this from the repo root whenever a Tailwind class is added or removed
anywhere under `app/` — the CLI tree-shakes by scanning the `content` globs, so
a class that is never scanned is never emitted:

```sh
npx tailwindcss@3.4.19 -o app/vendor/tailwind.css --minify
```

(No `-i` input file: without one the CLI uses the default
`@tailwind base; @tailwind components; @tailwind utilities;`, which is exactly
what the Play CDN injected.)

`tailwind.config.js` lists explicit globs (`app/index.html`, `app/main.js`,
`app/src/**/*.js`) rather than `app/**` so this directory is not scanned. Class
names are only ever written as whole literal strings in the sources — including
the segmented-control class strings in `app/src/view-toggles.js` — so no
`safelist` is needed. If you ever
build a class name by concatenation (`` `bg-${color}-500` ``), the CLI cannot see
it and you must add it to `safelist` in `tailwind.config.js`.

### Chart.js and patternomaly

```sh
curl -o app/vendor/chart.umd.js https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.js
curl -o app/vendor/patternomaly.min.js https://cdn.jsdelivr.net/npm/patternomaly@1.3.2/dist/patternomaly.min.js
```

Both are loaded as classic scripts and expose the globals `Chart` and `pattern`,
same as the CDN builds did.

### Fonts

`fonts/fonts.css` is the Google Fonts stylesheet with the remote `src` URLs
rewritten to the `.woff2` files next to it. Fetch it with a modern browser
user-agent, otherwise Google serves `.ttf` instead of `.woff2`:

```sh
curl -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36" \
  "https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
```

Then download each `latin` / `latin-ext` `.woff2` into `fonts/` and point the
`src` at it. Only those two subsets are vendored — the UI is English and they
cover the characters it renders; the Cyrillic, Greek and Vietnamese subsets the
CDN also offered are dropped. Both families are variable fonts, so all weights
of a family share one file per subset; the per-weight `@font-face` blocks are
kept as Google emitted them.

Consumers keep their fallback stacks (`'Outfit', system-ui, sans-serif` and
`'JetBrains Mono', ui-monospace, monospace`) in `app/styles.css`.
