/**
 * C1/C2 expand-phase guard. Prisma gives CalendarEvent.provider and sourceKey
 * defaults (so the previous release keeps working while the migration and the
 * new code overlap), which means the compiler no longer forces every writer to
 * set them. This scan does: every code path that creates or upserts a
 * CalendarEvent, or creates a LinkedCalendarAccount, must state its source, and
 * every module that reads CalendarEvent rows is accounted for, because since
 * C2 one event can be two rows (primary + linked calendar).
 *
 * A reader that is not in a list below fails the last describe: that is the
 * point of it. Decide whether the new reader dedupes (DEDUPED), is unaffected by
 * a duplicate (UNAFFECTED), or is a known gap for C7 (NOT_DEDUPED_YET).
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

const EVENT_WRITE = /\bcalendarEvent\s*\.\s*(create|createMany|upsert)\s*\(/g;
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
    const upserters = files.filter((f) => /\bcalendarEvent\s*\.\s*upsert\s*\(/.test(f.text));
    expect(upserters.map((f) => f.path)).toEqual([ROWS_MODULE]);
  });

  it("the linked-calendar upsert exists in exactly one place too", () => {
    const linkedWriters = files.filter((f) => /upsertLinkedGoogleEventRow\(/.test(f.text));
    expect(linkedWriters.map((f) => f.path).sort()).toEqual([ROWS_MODULE, "pim/calendar-sync.ts"]);
  });

  it.each([
    "automation-scheduler.ts",
    "routes/auth.ts",
    "routes/calendar.ts",
  ])("%s syncs the primary calendar through syncPrimaryCalendarWindow", (path) => {
    const file = files.find((f) => f.path === path);
    expect(file?.text).toContain("syncPrimaryCalendarWindow(");
  });

  it("the shared sync module is what reaches the row upserts", () => {
    const sync = files.find((f) => f.path === "pim/calendar-sync.ts");
    expect(sync?.text).toContain("upsertGoogleEventRow(");
    expect(sync?.text).toContain("upsertLinkedGoogleEventRow(");
  });

  it("no code outside the rows module builds a linked row's identity by hand", () => {
    const handBuilt = files
      .filter((f) => f.path !== ROWS_MODULE)
      .filter((f) => /\bsourceKey\s*:/.test(f.text))
      .map((f) => f.path);
    expect(handBuilt).toEqual([]);
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
  // secrets, whatever the provider. So does the dispatcher: it reads a row's
  // provider to choose the implementation.
  const ALL_PROVIDER_READERS = [
    "scripts/reencrypt-tokens.ts",
    "pim/calendar-providers/dispatch.ts",
  ];

  it("finds the known readers (so this guard cannot pass by scanning nothing)", () => {
    const readers = files.filter((f) => callWindows(f.text, READ).length > 0);
    expect(readers.map((f) => f.path).sort()).toEqual([
      "pim/calendar-providers/dispatch.ts",
      "pim/linked-calendar-unlink.ts",
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

describe("CalendarEvent readers: one event can be two rows (C2)", () => {
  const READ =
    /\bcalendarEvent\s*\.\s*(findMany|findFirst|findUnique|count|aggregate|groupBy|findFirstOrThrow|findUniqueOrThrow)\s*\(/g;
  const readerPaths = files
    .filter((f) => callWindows(f.text, READ).length > 0)
    .map((f) => f.path)
    .sort();

  // Lists or counts events for a person or a notification: they dedupe by
  // (provider, externalId) through pim/calendar-dedupe.ts. proactive-actions
  // dedupes the back-to-back warning only; its weekly count and tomorrow list are
  // a C7 gap (see the plan's C2 block).
  const DEDUPED = [
    "agentcore/agent-context.ts",
    "agentcore/proactive-actions.ts",
    "mail/meeting-context.ts",
    "pim/briefing-structure.ts",
    "pim/focus-digest.ts",
    "pim/inbox-summary.ts",
    "routes/calendar.ts",
  ];
  // Only ask "is this time busy?", fetch one row by id, or delete an account's
  // own rows: a duplicate row changes nothing, and a linked calendar's event
  // SHOULD block the slot.
  const UNAFFECTED = [
    "agentcore/tool-executor.ts",
    "notify/notification-prefs.ts",
    "pim/linked-calendar-unlink.ts",
    "pim/meeting-prep-pack.ts",
    "pim/team-availability.ts",
  ];
  // Known double counts while LINKED_CALENDAR_SYNC_ENABLED is on, left for C7
  // (the unified read path). Each is a count or a capped list, noted in the plan.
  const NOT_DEDUPED_YET = [
    "index.ts", // GDPR export: every row is exported on purpose
    "learning/interaction-graph.ts", // meeting-load bonus: a count
    "pim/briefing.ts", // collapses by (title, day) already, but take: 20 is spent on copies
    "routes/ops.ts", // "events today" count on the status page
  ];

  it("finds the readers (so this guard cannot pass by scanning nothing)", () => {
    expect(readerPaths.length).toBeGreaterThan(8);
  });

  it("every reader is either deduped, unaffected by a duplicate, or a known C7 gap", () => {
    const accounted = new Set([...DEDUPED, ...UNAFFECTED, ...NOT_DEDUPED_YET]);
    expect(readerPaths.filter((path) => !accounted.has(path))).toEqual([]);
  });

  it("the lists above name no module that has stopped reading events", () => {
    const stale = [...DEDUPED, ...UNAFFECTED, ...NOT_DEDUPED_YET].filter(
      (path) => !readerPaths.includes(path),
    );
    expect(stale).toEqual([]);
  });

  // Exempt from the kill switch on purpose: the GDPR export returns every row the
  // system holds, and unlink deletes an account's own rows.
  const EXEMPT_FROM_KILL_SWITCH = ["index.ts", "pim/linked-calendar-unlink.ts"];

  describe("kill switch: with LINKED_CALENDAR_SYNC_ENABLED off, every reader excludes linked rows", () => {
    const scoped = readerPaths.filter((path) => !EXEMPT_FROM_KILL_SWITCH.includes(path));

    it.each(
      scoped,
    )("%s scopes every list, count and first-row query with calendarSourceScope()", (path) => {
      const file = files.find((f) => f.path === path);
      const listReads = callWindows(
        file?.text ?? "",
        /\bcalendarEvent\s*\.\s*(findMany|findFirst|count|aggregate|groupBy|findFirstOrThrow)\s*\(/g,
      );
      for (const window of listReads) {
        // The scope helper, or a literal primary-only filter (stricter: it also
        // holds while the flag is on).
        expect(window.slice(0, 500)).toMatch(/calendarSourceScope\(\)|sourceAccountId:\s*null/);
      }
    });

    it.each(scoped)("%s checks isCalendarRowVisible() on every row it fetches by id", (path) => {
      const file = files.find((f) => f.path === path);
      const byId = callWindows(
        file?.text ?? "",
        /\bcalendarEvent\s*\.\s*(findUnique|findUniqueOrThrow)\s*\(/g,
      );
      if (byId.length > 0) expect(file?.text).toContain("isCalendarRowVisible(");
    });
  });

  it.each(DEDUPED)("%s dedupes through dedupeCalendarEvents", (path) => {
    const file = files.find((f) => f.path === path);
    expect(file?.text).toContain("dedupeCalendarEvents(");
  });

  it("the dropped C1 unique is referenced nowhere; the per-source unique only by the rows module", () => {
    expect(files.filter((f) => f.text.includes("userId_provider_externalId"))).toEqual([]);
    const keyed = files.filter((f) => f.text.includes("userId_provider_sourceKey_externalId"));
    expect(keyed.map((f) => f.path)).toEqual([ROWS_MODULE]);
  });
});
