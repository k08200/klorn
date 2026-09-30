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
 * a duplicate (UNAFFECTED), or returns every row on purpose (EXPORTS_EVERYTHING).
 * Since C7 the lists, counts and capped reads that used to be C2 gaps go through
 * pim/calendar-read.ts, the one read path, and no longer read the table themselves.
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
  // The source label reads an account's email by id, for a row that already
  // names it: provider-agnostic on purpose, it only labels.
  const ALL_PROVIDER_READERS = [
    "scripts/reencrypt-tokens.ts",
    "pim/calendar-providers/dispatch.ts",
    "pim/calendar-source-label.ts",
  ];

  it("finds the known readers (so this guard cannot pass by scanning nothing)", () => {
    const readers = files.filter((f) => callWindows(f.text, READ).length > 0);
    expect(readers.map((f) => f.path).sort()).toEqual([
      "pim/calendar-providers/dispatch.ts",
      "pim/calendar-source-label.ts",
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
  // (provider, externalId) through pim/calendar-dedupe.ts, directly or (the C7
  // read path) for every reader that used to be a known gap.
  const DEDUPED = [
    "agentcore/agent-context.ts",
    "agentcore/proactive-actions.ts",
    "mail/meeting-context.ts",
    "pim/calendar-read.ts",
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
    "pim/calendar-rows.ts", // removes the rows Google named as cancelled, scoped to one source
    "pim/linked-calendar-unlink.ts",
    "pim/meeting-prep-pack.ts",
    "pim/team-availability.ts",
  ];
  // Returns every row on purpose.
  const EXPORTS_EVERYTHING = [
    "index.ts", // GDPR export: every row is exported
  ];

  it("finds the readers (so this guard cannot pass by scanning nothing)", () => {
    expect(readerPaths.length).toBeGreaterThan(8);
  });

  it("every reader is either deduped, unaffected by a duplicate, or exports everything on purpose", () => {
    const accounted = new Set([...DEDUPED, ...UNAFFECTED, ...EXPORTS_EVERYTHING]);
    expect(readerPaths.filter((path) => !accounted.has(path))).toEqual([]);
  });

  it("the lists above name no module that has stopped reading events", () => {
    const stale = [...DEDUPED, ...UNAFFECTED, ...EXPORTS_EVERYTHING].filter(
      (path) => !readerPaths.includes(path),
    );
    expect(stale).toEqual([]);
  });

  // Exempt from the kill switch on purpose: the GDPR export returns every row the
  // system holds, unlink deletes an account's own rows, and the cancelled-event
  // removal deletes the rows of the one source whose sync named them (sourceKey).
  const EXEMPT_FROM_KILL_SWITCH = [
    "index.ts",
    "pim/calendar-rows.ts",
    "pim/linked-calendar-unlink.ts",
  ];

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

  describe("C7: the C2 gaps read through the one read path", () => {
    const VIA_READ_PATH = [
      "learning/interaction-graph.ts",
      "pim/briefing-structure.ts",
      "pim/briefing.ts",
      "routes/ops.ts",
    ];

    it.each(VIA_READ_PATH)("%s no longer reads the table itself", (path) => {
      const file = files.find((f) => f.path === path);
      expect(file?.text).toMatch(/\b(readCalendarRows|countCalendarRows)\(/);
      expect(file?.text).not.toMatch(/\bcalendarEvent\s*\.\s*\w+\s*\(/);
    });

    it("the weekly review count and tomorrow list in proactive-actions use it too", () => {
      const file = files.find((f) => f.path === "agentcore/proactive-actions.ts");
      expect(file?.text).toContain("countCalendarRows(");
      expect(file?.text).toContain("readCalendarRows(");
      // What still reads the table directly there dedupes (back-to-back) or is
      // covered by the notification dedupe (upcoming meetings).
      expect(file?.text).not.toMatch(/calendarEvent\s*\.\s*count\(/);
    });

    it("list_events and the conflict check read through it, behind the flag", () => {
      const file = files.find((f) => f.path === "pim/calendar.ts");
      expect(file?.text).toContain("unifiedCalendarReadEnabled()");
      expect(file?.text).toMatch(/readUpcomingEvents\(|readCalendarRows\(/);
      expect(file?.text).not.toMatch(/\bcalendarEvent\s*\.\s*\w+\s*\(/);
    });
  });

  // Calendar text is external content (an invite's author writes the title). The
  // audit of every module that reads rows or events, for whether the text can reach
  // an LLM: the ones that can wrap it (tested per reader), the ones that cannot
  // must not start importing the LLM without this list being revisited.
  describe("C7: calendar text reaches an LLM only wrapped", () => {
    const LLM_FACING: Array<[string, RegExp]> = [
      ["agentcore/agent-context.ts", /wrapUntrusted\(e\.title/],
      ["agentcore/tool-executor.ts", /wrapUntrusted\(dupCheck\.title/],
      ["mail/meeting-context.ts", /wrapUntrusted\(e\.title/],
      ["pim/briefing.ts", /wrapEventsForPrompt\(/],
      ["pim/calendar-read-format.ts", /wrapUntrusted\(row\.title/],
    ];
    // Modules that read calendar rows and never touch an LLM, directly or by a
    // dynamic import.
    const NOT_LLM_FACING = [
      "agentcore/proactive-actions.ts", // notifications the user reads
      "pim/briefing-structure.ts", // the rule-based day shape
      "pim/focus-digest.ts",
      "pim/inbox-summary.ts",
      "pim/meeting-prep-pack.ts",
      "pim/team-availability.ts",
      "learning/interaction-graph.ts",
    ];
    // Modules that reach LLM-adjacent code, with the exact specifiers they use and why
    // no calendar row text can ride along.
    const LLM_ADJACENT: Array<[string, string[], string]> = [
      [
        "routes/calendar.ts",
        ["../event-parse.js"], // dynamic import in POST /parse-event
        "event-parse sends the user's own spoken or typed utterance to the model, never a row",
      ],
      [
        "routes/ops.ts",
        ["../llm/model-fallback.js"],
        "snapshotUserProviderCooldowns reads in-memory provider cooldowns, no prompt",
      ],
    ];

    /** Every static or dynamic import specifier that reaches the LLM client or its helpers. */
    function llmSpecifiers(text: string): string[] {
      const found = [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g)].map(
        (match) => match[1] ?? "",
      );
      return found.filter(
        (spec) => /(^|\/)llm\//.test(spec) || /(^|\/)event-parse(\.js)?$/.test(spec),
      );
    }

    it.each(
      LLM_FACING,
    )("%s wraps the calendar text it puts in front of a model", (path, pattern) => {
      expect(files.find((f) => f.path === path)?.text).toMatch(pattern);
    });

    it.each(
      NOT_LLM_FACING,
    )("%s imports nothing from the LLM, statically or dynamically", (path) => {
      const text = files.find((f) => f.path === path)?.text ?? "";
      expect(text.length).toBeGreaterThan(0);
      expect(llmSpecifiers(text)).toEqual([]);
      expect(text).not.toMatch(/createCompletion/);
    });

    it.each(LLM_ADJACENT)("%s reaches the LLM only through %j (%s)", (path, specifiers) => {
      const text = files.find((f) => f.path === path)?.text ?? "";
      expect(llmSpecifiers(text).sort()).toEqual([...specifiers].sort());
      expect(text).not.toMatch(/createCompletion/);
    });

    it("the detector sees a dynamic import and a llm-json import (so the lists above cannot go stale silently)", () => {
      expect(llmSpecifiers('const x = await import("../llm/llm-json.js");')).toEqual([
        "../llm/llm-json.js",
      ]);
      expect(llmSpecifiers('import { a } from "../llm/model-fallback.js";')).toEqual([
        "../llm/model-fallback.js",
      ]);
      expect(llmSpecifiers('import("../event-parse.js")')).toEqual(["../event-parse.js"]);
      expect(llmSpecifiers('import { z } from "../pim/calendar-read.js";')).toEqual([]);
    });
  });

  it("the dropped C1 unique is referenced nowhere; the per-source unique only by the rows module", () => {
    expect(files.filter((f) => f.text.includes("userId_provider_externalId"))).toEqual([]);
    const keyed = files.filter((f) => f.text.includes("userId_provider_sourceKey_externalId"));
    expect(keyed.map((f) => f.path)).toEqual([ROWS_MODULE]);
  });
});
