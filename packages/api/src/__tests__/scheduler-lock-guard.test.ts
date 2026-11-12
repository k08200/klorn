/**
 * No session-level advisory locks (2026-11-11).
 *
 * The app reaches Postgres through a pooler (Supavisor in production), so two
 * statements from one Prisma client can run on two different backends. A
 * session advisory lock taken by one statement and released by another
 * therefore leaks: the release returns false on the wrong backend, the lock
 * stays with an idle backend that outlives the app, and every caller that
 * lands elsewhere is refused. That stalled the automation scheduler for hours.
 *
 * Mutual exclusion across instances goes through scheduler-lease.ts (a row
 * lease). Transaction-scoped locks (`pg_advisory_xact_lock`,
 * `pg_try_advisory_xact_lock`) are fine inside one `$transaction`: they end
 * with it, on the backend that took them.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

/** The text with `//` and block comments removed: only code counts. */
function codeOf(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

// pg_advisory_lock, pg_try_advisory_lock, their _shared forms, and every
// unlock, in any case. The xact forms never match: "xact_" sits between
// "advisory_" and "lock".
const SESSION_LOCK = /\bpg_(?:try_)?advisory_(?:lock|unlock)(?:_shared|_all)?\b/i;

describe("no session-level advisory lock in the API", () => {
  it("the pattern catches the session forms and spares the transaction forms", () => {
    for (const call of [
      "pg_try_advisory_lock($1)",
      "pg_advisory_lock($1)",
      "pg_advisory_unlock($1)",
      "pg_advisory_unlock_all()",
      "pg_try_advisory_lock_shared($1)",
      "PG_ADVISORY_LOCK($1)",
    ]) {
      expect(SESSION_LOCK.test(call), call).toBe(true);
    }
    for (const call of [
      "pg_advisory_xact_lock($1)",
      "pg_try_advisory_xact_lock($1)",
      "PG_ADVISORY_XACT_LOCK($1)",
    ]) {
      expect(SESSION_LOCK.test(call), call).toBe(false);
    }
  });

  it("no source file takes or releases one", () => {
    const offenders = sourceFiles(srcDir)
      .filter((full) => SESSION_LOCK.test(codeOf(readFileSync(full, "utf8"))))
      .map((full) => relative(srcDir, full));
    expect(offenders).toEqual([]);
  });
});
