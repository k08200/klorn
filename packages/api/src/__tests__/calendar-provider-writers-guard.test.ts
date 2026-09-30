/**
 * C1 expand-phase guard. Prisma gives CalendarEvent.provider a default (so the
 * previous release keeps working while the migration and the new code overlap),
 * which means the compiler no longer forces every writer to set it. This scan
 * does: every code path that creates or upserts a CalendarEvent, or creates a
 * LinkedCalendarAccount, must state its provider, and nothing reads the new
 * columns yet (reads stay on googleId until C7).
 *
 * When C2/C7 start reading provider/externalId, update the last describe —
 * that is the point of it failing.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROWS_MODULE = "pim/calendar-rows.ts";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

const files = sourceFiles(srcDir).map((full) => ({
  path: relative(srcDir, full),
  text: readFileSync(full, "utf8"),
}));

/** The text of each call to `pattern`, up to the next statement-ish boundary. */
function callWindows(text: string, pattern: RegExp): string[] {
  const windows: string[] = [];
  for (const match of text.matchAll(pattern)) {
    windows.push(text.slice(match.index ?? 0, (match.index ?? 0) + 900));
  }
  return windows;
}

const EVENT_WRITE = /\.calendarEvent\.(create|createMany|upsert)\(/g;
const ACCOUNT_WRITE = /\.linkedCalendarAccount\.(create|createMany|upsert)\(/g;
const STATES_SOURCE = /provider:|\b\w*[eE]ventSource\w*\(/;

describe("every CalendarEvent writer states its provider", () => {
  const writers = files.filter((f) => callWindows(f.text, EVENT_WRITE).length > 0);

  it("finds the known writers (so this guard cannot pass by scanning nothing)", () => {
    expect(writers.map((f) => f.path).sort()).toEqual([
      "agentcore/tool-executor.ts",
      "auth.ts",
      "pim/calendar-rows.ts",
      "routes/calendar.ts",
    ]);
  });

  it.each(
    writers.map((f) => [f.path, f]),
  )("%s sets provider on every create/upsert", (_p, file) => {
    const { text } = file as (typeof files)[number];
    for (const window of callWindows(text, EVENT_WRITE)) {
      expect(window).toMatch(STATES_SOURCE);
    }
  });

  it("the Google sync upsert exists in exactly one place", () => {
    const upserters = files.filter((f) => /\.calendarEvent\.upsert\(/.test(f.text));
    expect(upserters.map((f) => f.path)).toEqual([ROWS_MODULE]);
  });

  it.each([
    "automation-scheduler.ts",
    "routes/auth.ts",
    "routes/calendar.ts",
  ])("%s syncs Google events through upsertGoogleEventRow", (path) => {
    const file = files.find((f) => f.path === path);
    expect(file?.text).toContain("upsertGoogleEventRow(");
  });
});

describe("every LinkedCalendarAccount writer states its provider", () => {
  it("routes/auth.ts link-calendar upsert names provider GOOGLE in both the key and the create", () => {
    const auth = files.find((f) => f.path === "routes/auth.ts");
    const windows = callWindows(auth?.text ?? "", ACCOUNT_WRITE);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toContain("userId_provider_email");
    expect(windows[0]).toMatch(/create:\s*\{[^}]*provider:\s*"GOOGLE"/);
  });

  it("no other module creates a LinkedCalendarAccount", () => {
    const writers = files.filter((f) => callWindows(f.text, ACCOUNT_WRITE).length > 0);
    expect(writers.map((f) => f.path)).toEqual(["routes/auth.ts"]);
  });
});

describe("Google-only LinkedCalendarAccount readers filter on provider", () => {
  const READ = /\.linkedCalendarAccount\.(findMany|findFirst|findUnique|count)\(/g;
  // The key-rotation sweep reads every provider on purpose: it re-encrypts all
  // secrets, whatever the provider.
  const ALL_PROVIDER_READERS = ["scripts/reencrypt-tokens.ts"];

  it("finds the known readers (so this guard cannot pass by scanning nothing)", () => {
    const readers = files.filter((f) => callWindows(f.text, READ).length > 0);
    expect(readers.map((f) => f.path).sort()).toEqual([
      "mail/gmail.ts",
      "routes/auth.ts",
      "scripts/reencrypt-tokens.ts",
    ]);
  });

  it("every other reader names a provider, so a CalDAV or Outlook row never reaches Google code", () => {
    const offenders = files
      .filter((f) => !ALL_PROVIDER_READERS.includes(f.path))
      .flatMap((f) => callWindows(f.text, READ).map((window) => ({ path: f.path, window })))
      .filter(({ window }) => !/provider:/.test(window.slice(0, 300)))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });
});

describe("expand phase: nothing reads the new columns yet", () => {
  it("externalId and sourceAccountId appear only in the rows module", () => {
    const readers = files
      .filter((f) => f.path !== ROWS_MODULE)
      .filter((f) => /\b(externalId|sourceAccountId)\b/.test(f.text));
    expect(readers.map((f) => f.path)).toEqual([]);
  });

  it("no calendar lookup keys on the new unique (userId_provider_externalId)", () => {
    const readers = files.filter((f) => f.text.includes("userId_provider_externalId"));
    expect(readers.map((f) => f.path)).toEqual([]);
  });
});
