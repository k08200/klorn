/**
 * Boot-level guard: every module the API entry point imports must link under
 * Node's real ESM loader. vitest cannot see this on its own — its module
 * interop hands back the namespace when a package has no default export, so
 * `import webPush from "web-push"` passed every suite on web-push 4 (ESM-only,
 * no default) while `node dist/index.js` died at boot. This runs
 * scripts/esm-import-smoke.mjs in a separate Node process (tsx compiles the
 * sources; Node links them), with no database URL and no port: it only loads
 * modules, it never starts the server. CI also runs the same script against
 * the built dist/ in the Build job.
 */

import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const API_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Generous: compiling and linking the whole graph in a fresh process takes a
// few seconds alone and much longer while the full suite saturates the CPU.
const SMOKE_TIMEOUT_MS = 110_000;

describe("API module graph under Node's ESM loader", () => {
  it(
    "loads every module index imports without a missing-export SyntaxError",
    async () => {
      const result = await run(
        process.execPath,
        ["--import", "tsx", "scripts/esm-import-smoke.mjs", "src"],
        {
          cwd: API_ROOT,
          // Bare environment: loading must not depend on DATABASE_URL or any
          // secret, and nothing here may reach a real service. NODE_ENV=test
          // lets modules that refuse keyless secrets outside dev/test load.
          env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "test" },
          timeout: SMOKE_TIMEOUT_MS,
        },
      ).catch((err: { stdout?: string; stderr?: string; code?: unknown }) => err);

      // On failure the message carries the script's stderr (the module and
      // the SyntaxError it hit).
      expect(result.stdout ?? "", result.stderr).toMatch(/^esm-import-smoke: loaded \d+ modules/m);
    },
    SMOKE_TIMEOUT_MS + 10_000,
  );
});
