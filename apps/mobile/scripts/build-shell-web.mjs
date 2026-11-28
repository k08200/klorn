#!/usr/bin/env node
/**
 * Opt-in shell build (PR6a): the packages/web static export as the app's web
 * bundle, in place of the Vite app in src/. Writes apps/mobile/web-export/,
 * which capacitor.config.ts uses as webDir only when KLORN_MOBILE_SHELL=1:
 *
 *   npm run build:shell                      # export + copy + route check
 *   KLORN_MOBILE_SHELL=1 npx cap sync        # (npm run sync:shell does both)
 *
 * The default `npm run build` / `cap sync` path (dist/, the Vite app) is untouched.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkShellExport, deadRedirects } from "../shell/check-shell-export.mjs";

const MOBILE = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(MOBILE, "../..");
const OUT = join(REPO, "packages/web/out");
const TARGET = join(MOBILE, "web-export");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: REPO, stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    console.error(`✗ ${command} ${args.join(" ")} exited ${result.status ?? result.signal}`);
    process.exit(result.status ?? 1);
  }
}

if (!process.argv.includes("--skip-export")) {
  run("pnpm", ["--filter", "@klorn/web", "build:static"]);
}
if (!existsSync(join(OUT, "index.html"))) {
  console.error(`✗ ${OUT}/index.html missing — run the static export first`);
  process.exit(1);
}

rmSync(TARGET, { recursive: true, force: true });
cpSync(OUT, TARGET, { recursive: true });
// Cloudflare-only files: the native routers read shell-routes.json instead.
for (const name of ["_headers", "_redirects"]) rmSync(join(TARGET, name), { force: true });
copyFileSync(join(MOBILE, "shell/shell-routes.json"), join(TARGET, "shell-routes.json"));

for (const warning of deadRedirects(TARGET)) console.warn(`! shell export: ${warning}`);
const problems = checkShellExport(TARGET);
if (problems.length > 0) {
  console.error(`✗ shell export:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`✓ shell export copied to ${TARGET} and routes every page and shell`);
