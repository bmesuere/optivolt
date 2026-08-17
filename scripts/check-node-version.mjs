// Plain ESM/JS (no TypeScript syntax) so it can run on ANY Node version,
// including ones too old to type-strip api/index.ts. Node refuses to even
// load a .ts entry point when type stripping isn't available (or isn't on
// by default), which produces a confusing parser error rather than a
// helpful message. Running this preflight first gives a clear, actionable
// error before that happens.
//
// This does NOT cover Home Assistant add-on / Docker deployments, which
// exec node directly (bypassing npm scripts) — see the version check in
// addon/rootfs/etc/services.d/optivolt/run for that path.

const MIN_NODE_VERSION = [22, 18, 0];

function parseVersion(version) {
  return version.replace(/^v/, '').split('.').map(Number);
}

function isAtLeast(actual, min) {
  for (let i = 0; i < min.length; i++) {
    const a = actual[i] ?? 0;
    const m = min[i];
    if (a > m) return true;
    if (a < m) return false;
  }
  return true;
}

const actual = parseVersion(process.version);

if (!isAtLeast(actual, MIN_NODE_VERSION)) {
  console.error(
    `OptiVolt requires Node >= ${MIN_NODE_VERSION.join('.')} for TypeScript type stripping; found ${process.version}`
  );
  process.exit(1);
}
