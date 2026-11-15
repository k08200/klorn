#!/usr/bin/env node
// Entry point for the `klorn` operations CLI: TypeScript run through tsx, no
// build step and nothing generated to keep in sync.
//
// tsx would otherwise cache compiled modules under os.tmpdir(); on a shared
// host another user could pre-create that directory and plant code there. The
// CLI is small, so compile on every run instead. Set before tsx loads.
process.env.TSX_DISABLE_CACHE = "1";
const { register } = await import("tsx/esm/api");
register();
const { main, onSignal } = await import("../src/main.ts");
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.once(signal, () => {
    onSignal();
    process.exit(code);
  });
}
process.exitCode = await main(process.argv.slice(2));
