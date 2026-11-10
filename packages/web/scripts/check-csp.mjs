#!/usr/bin/env node
/**
 * The web's Content-Security-Policy, pinned (step D5c of
 * docs/providers/unified-platform-plan.md).
 *
 * The Google Picker widens the policy, so it is a build switch:
 * NEXT_PUBLIC_GOOGLE_DRIVE_PICKER=on (exactly "on") adds https://apis.google.com
 * to script-src and https://docs.google.com to frame-src, and nothing else.
 * Without it the policy must stay byte for byte what it was before D5c. This
 * loads the REAL next.config.ts (Node's type stripping; it imports only types
 * from "next") once per variant, each in a fresh process with a production
 * environment, and compares the Content-Security-Policy header it serves.
 *
 * The web package has no unit-test runner, so this is a script. CI runs it in
 * the Build job (.github/workflows/ci.yml). A deliberate policy change updates
 * PINNED below in the same commit.
 *
 * Run: node packages/web/scripts/check-csp.mjs   (Node 22.6 or later)
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CONFIG_URL = new URL("../next.config.ts", import.meta.url).href;

/** The policy of a production build against the default API origin, before D5c. */
const PINNED = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://*.paddle.com",
  "style-src 'self' 'unsafe-inline' https://*.paddle.com",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://klorn-api.onrender.com wss://klorn-api.onrender.com https://*.sentry.io https://*.ingest.sentry.io https://*.ingest.us.sentry.io https://*.paddle.com",
  "media-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-src https://*.paddle.com https://*.paddle.io",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

/** With the switch on: the pinned policy plus exactly the Picker's two origins. */
const WITH_PICKER = PINNED.replace(
  "script-src 'self' 'unsafe-inline' https://*.paddle.com;",
  "script-src 'self' 'unsafe-inline' https://*.paddle.com https://apis.google.com;",
).replace(
  "frame-src https://*.paddle.com https://*.paddle.io;",
  "frame-src https://*.paddle.com https://*.paddle.io https://docs.google.com;",
);

const READ_POLICY = `
const config = (await import(process.env.CHECK_CSP_CONFIG_URL)).default;
const rules = await config.headers();
const header = rules.flatMap((rule) => rule.headers).find((h) => h.key === "Content-Security-Policy");
process.stdout.write(JSON.stringify(header ? header.value : null));
`;

function fail(message) {
  console.error(`✗ CSP: ${message}`);
  process.exit(1);
}

/** The policy next.config.ts serves with this value of the switch (undefined: unset). */
function policyWith(pickerSwitch) {
  const env = { ...process.env, NODE_ENV: "production", CHECK_CSP_CONFIG_URL: CONFIG_URL };
  delete env.NEXT_PUBLIC_API_URL;
  delete env.NEXT_PUBLIC_GOOGLE_DRIVE_PICKER;
  if (pickerSwitch !== undefined) env.NEXT_PUBLIC_GOOGLE_DRIVE_PICKER = pickerSwitch;
  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", READ_POLICY],
    { env, encoding: "utf8", cwd: fileURLToPath(new URL("..", import.meta.url)) },
  );
  if (run.status !== 0) {
    fail(`could not load next.config.ts (switch ${String(pickerSwitch)}):\n${run.stderr}`);
  }
  return JSON.parse(run.stdout);
}

/** The first directive that differs, for a readable failure. */
function firstDifference(actual, expected) {
  const a = String(actual).split("; ");
  const e = expected.split("; ");
  for (let i = 0; i < Math.max(a.length, e.length); i += 1) {
    if (a[i] !== e[i]) return `directive ${i + 1}: got "${a[i]}", expected "${e[i]}"`;
  }
  return "no directive differs";
}

function expectPolicy(pickerSwitch, expected, label) {
  const actual = policyWith(pickerSwitch);
  if (actual !== expected) fail(`${label}: ${firstDifference(actual, expected)}`);
  console.log(`✓ CSP: ${label}`);
}

if (WITH_PICKER === PINNED) fail("the Picker variant did not change the pinned policy");

expectPolicy(undefined, PINNED, "switch unset: unchanged");
for (const value of ["", "off", "ON", "true", "1", " on"]) {
  expectPolicy(value, PINNED, `switch ${JSON.stringify(value)}: unchanged (only "on" turns it on)`);
}
expectPolicy("on", WITH_PICKER, 'switch "on": exactly apis.google.com and docs.google.com added');
