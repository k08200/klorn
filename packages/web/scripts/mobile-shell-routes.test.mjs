// Run: node --test packages/web/scripts/mobile-shell-routes.test.mjs
//
// The mobile shell (apps/mobile, Capacitor) serves this static export from the
// app bundle, where Cloudflare's _redirects never runs. Its native routers read
// apps/mobile/shell/shell-routes.json instead; this fails when that committed
// table drifts from next.config.ts redirects() or from the routes in src/app.
// Regenerate: node packages/web/scripts/mobile-shell-routes.mjs --write
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  MOBILE_SHELL_ROUTES_FILE,
  mobileShellRoutes,
  renderMobileShellRoutes,
} from "./mobile-shell-routes.mjs";

test("apps/mobile/shell/shell-routes.json matches next.config.ts and src/app", () => {
  const committed = readFileSync(MOBILE_SHELL_ROUTES_FILE, "utf8");
  assert.equal(
    committed,
    renderMobileShellRoutes(mobileShellRoutes()),
    "stale — run: node packages/web/scripts/mobile-shell-routes.mjs --write",
  );
});

test("every dynamic-route shell is in the table, longest prefix first", () => {
  const { shells } = mobileShellRoutes();
  const prefixes = shells.map((shell) => shell.prefix);
  for (const prefix of ["/email/", "/email/candidates/", "/calendar/"]) {
    assert.ok(prefixes.includes(prefix), `missing shell ${prefix}`);
  }
  for (let i = 1; i < prefixes.length; i++) {
    assert.ok(prefixes[i - 1].length >= prefixes[i].length, "shells must be longest-prefix first");
  }
  for (const shell of shells) assert.equal(shell.target, `${shell.prefix}_`);
});

test("redirects are next.config.ts redirects() as plain paths", () => {
  const { redirects } = mobileShellRoutes();
  assert.ok(redirects.some((r) => r.from === "/dashboard" && r.to === "/inbox"));
  for (const r of redirects) {
    assert.match(r.from, /^\/[A-Za-z0-9\-._~/]*$/);
    assert.match(r.to, /^\/[A-Za-z0-9\-._~/]*$/);
  }
});
