/**
 * Tailwind config for the static UI in `app/`.
 *
 * This used to live as an inline `tailwind.config = {...}` block in
 * `app/index.html`, next to the Tailwind Play CDN script. The CDN is explicitly
 * not for production and needs internet access, which a Home Assistant add-on
 * on an offline LAN does not have, so the stylesheet is now built once with the
 * Tailwind CLI and committed to `app/vendor/tailwind.css`.
 *
 * Regenerate after adding/removing Tailwind classes anywhere under `app/`:
 *
 *   npx tailwindcss@3.4.19 -o app/vendor/tailwind.css --minify
 *
 * See `app/vendor/README.md`.
 */
export default {
  // Explicit globs rather than `app/**` so the vendored third-party bundles in
  // `app/vendor/` are not scanned for class names.
  content: [
    "./app/index.html",
    "./app/main.js",
    "./app/src/**/*.js",
  ],
  theme: {
    extend: {
      colors: {
        card: { DEFAULT: "#ffffff", dark: "#111827" },
        ink: { DEFAULT: "#0f172a", soft: "#475569" }
      },
      boxShadow: {
        soft: "0 1px 2px rgb(0 0 0 / 0.04), 0 8px 24px rgb(0 0 0 / 0.06)"
      },
      borderRadius: { pill: "9999px" }
    }
  },
  darkMode: "class"
};
