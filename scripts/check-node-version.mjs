// Plain JS (no TS syntax) so this runs on any Node, including ones that
// can't parse .ts. The add-on path has its own check in the run script.

export function supportsTypeStripping(version) {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  if (major === 22) return minor >= 18;
  if (major === 23) return minor >= 6;
  return major > 23;
}

function main() {
  if (!supportsTypeStripping(process.version)) {
    console.error(
      `OptiVolt requires Node >=22.18 <23 or >=23.6 for TypeScript type stripping; found ${process.version}`
    );
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
