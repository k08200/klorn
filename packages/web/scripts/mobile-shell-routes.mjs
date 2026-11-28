#!/usr/bin/env node
/**
 * The route table the mobile shell's native routers read in place of
 * Cloudflare's public/_redirects (apps/mobile/shell/resolve-route.mjs explains
 * why). Built from the same functions that produce _redirects, so the shell and
 * app.klorn.ai serve the same file for the same path:
 *
 *   - redirects: next.config.ts redirects() (plain paths only);
 *   - shells: the `/<prefix>/:id` → `/<prefix>/_` rewrites of expectedShellRules,
 *     longest prefix first. Static siblings need no entry: the native router
 *     serves an existing file before it tries a shell.
 *
 * Run: node packages/web/scripts/mobile-shell-routes.mjs [--write]
 * Guard: packages/web/scripts/mobile-shell-routes.test.mjs (CI).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appRoutes,
  expectedRedirects,
  expectedShellRules,
  loadNextConfig,
  PRODUCTION_BUILD_ENV,
  SHELL_PARAM,
  WEB_ROOT,
} from "./cloudflare-pages-rules.mjs";

export const MOBILE_SHELL_ROUTES_FILE = join(WEB_ROOT, "../../apps/mobile/shell/shell-routes.json");

const SHELL_REWRITE = /^(\/(?:[^:]*\/)?):\w+$/;

export function mobileShellRoutes() {
  const config = loadNextConfig(PRODUCTION_BUILD_ENV);
  const redirects = expectedRedirects(config.redirects ?? []).map(({ from, to }) => ({ from, to }));
  const shells = [];
  for (const rule of expectedShellRules(appRoutes(join(WEB_ROOT, "src/app")))) {
    const match = SHELL_REWRITE.exec(rule.from);
    if (!match || rule.status !== 200) continue;
    const prefix = match[1];
    if (rule.to !== `${prefix}${SHELL_PARAM}`) {
      throw new Error(`unexpected shell rewrite ${rule.from} → ${rule.to}`);
    }
    shells.push({ prefix, target: rule.to });
  }
  return { redirects, shells };
}

export function renderMobileShellRoutes(routes) {
  return `${JSON.stringify(routes, null, 2)}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = renderMobileShellRoutes(mobileShellRoutes());
  if (process.argv.includes("--write")) {
    writeFileSync(MOBILE_SHELL_ROUTES_FILE, text);
    console.log(`wrote ${MOBILE_SHELL_ROUTES_FILE}`);
  } else {
    process.stdout.write(text);
  }
}
