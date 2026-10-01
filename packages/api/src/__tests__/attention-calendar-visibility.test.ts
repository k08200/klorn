/**
 * An attention item mirrors a calendar event: `attention-mirror.ts` copies the
 * event's title into a `CALENDAR_EVENT` item, and a reader that shows open items
 * of every source (the briefing's "needs attention") would keep showing that title
 * after the kill switch hid the event itself: turn OUTLOOK_CALENDAR_ENABLED off, or
 * never turn the linked sync on, and a work meeting's name still reaches the screen
 * and the model. So a reader of `CALENDAR_EVENT` items drops an item whose event
 * is not visible, with one batch lookup for the whole list.
 *
 * Primary Google rows are always visible, so nothing changes for them.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeEvent {
  id: string;
  userId: string;
  provider: string;
  sourceAccountId: string | null;
  // The rest is what the day shape reads when the briefing lists the day's events.
  title: string;
  description: null;
  location: null;
  startTime: Date;
  endTime: Date;
  allDay: boolean;
  externalId: string;
}

const state = vi.hoisted(() => ({
  events: [] as unknown[],
  pushItems: [] as unknown[],
}));

function matches(row: FakeEvent, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") return (value as Record<string, unknown>[]).some((w) => matches(row, w));
    if (key === "AND") return (value as Record<string, unknown>[]).every((w) => matches(row, w));
    if (key === "userId") return row.userId === value;
    if (key === "id") return (value as { in: string[] }).in.includes(row.id);
    if (key === "sourceAccountId") return row.sourceAccountId === value;
    if (key === "provider") {
      const { in: only, notIn } = value as { in?: string[]; notIn?: string[] };
      return (only === undefined || only.includes(row.provider)) && !notIn?.includes(row.provider);
    }
    return true;
  });
}

vi.mock("../db.js", () => ({
  prisma: {
    calendarEvent: {
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) =>
        (state.events as FakeEvent[]).filter((row) => matches(row, args.where)),
      ),
    },
    attentionItem: { findMany: vi.fn(async () => state.pushItems) },
    automationConfig: { findUnique: vi.fn(async () => ({ notificationLanguage: "en" })) },
  },
}));
vi.mock("../user-timezone.js", () => ({ getUserTimeZone: vi.fn(async () => "Asia/Seoul") }));

import { prisma } from "../db.js";
import { withoutHiddenCalendarItems } from "../pim/attention-calendar-visibility.js";
import { buildBriefingStructure } from "../pim/briefing-structure.js";

const ENV_KEYS = [
  "LINKED_CALENDAR_SYNC_ENABLED",
  "OUTLOOK_CALENDAR_ENABLED",
  "OUTLOOK_INBOX_ENABLED",
] as const;
const saved: Record<string, string | undefined> = {};

function setFlags(env: { linked?: boolean; outlook?: boolean }) {
  process.env.LINKED_CALENDAR_SYNC_ENABLED = env.linked ? "true" : "false";
  process.env.OUTLOOK_CALENDAR_ENABLED = env.outlook ? "true" : "false";
  process.env.OUTLOOK_INBOX_ENABLED = env.outlook ? "true" : "false";
}

const event = (
  id: string,
  provider: string,
  sourceAccountId: string | null,
  userId = "u1",
): FakeEvent => ({
  id,
  userId,
  provider,
  sourceAccountId,
  title: `Event ${id}`,
  description: null,
  location: null,
  startTime: new Date("2026-10-01T03:00:00.000Z"),
  endTime: new Date("2026-10-01T04:00:00.000Z"),
  allDay: false,
  externalId: `ext-${id}`,
});
const item = (id: string, source: string, sourceId: string, title = `Title ${id}`) => ({
  id,
  source,
  sourceId,
  title,
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  setFlags({});
  state.events = [
    event("ev-primary", "GOOGLE", null),
    event("ev-glinked", "GOOGLE", "acct-g"),
    event("ev-outlook", "OUTLOOK", "acct-out"),
  ];
  state.pushItems = [];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const calendarItems = () => [
  item("a-primary", "CALENDAR_EVENT", "ev-primary"),
  item("a-glinked", "CALENDAR_EVENT", "ev-glinked"),
  item("a-outlook", "CALENDAR_EVENT", "ev-outlook"),
];
const ids = (items: Array<{ id: string }>) => items.map((i) => i.id);

describe("withoutHiddenCalendarItems", () => {
  it.each([
    ["both flags off", { linked: false, outlook: false }, ["a-primary"]],
    ["only the Outlook flags on", { linked: false, outlook: true }, ["a-primary", "a-outlook"]],
    ["only the linked sync on", { linked: true, outlook: false }, ["a-primary", "a-glinked"]],
    ["both on", { linked: true, outlook: true }, ["a-primary", "a-glinked", "a-outlook"]],
  ])("%s", async (_label, env, expected) => {
    setFlags(env);

    expect(ids(await withoutHiddenCalendarItems("u1", calendarItems()))).toEqual(expected);
  });

  it("an item of an Outlook event is hidden with its flags OFF and shown with them ON", async () => {
    const outlookOnly = [item("a-outlook", "CALENDAR_EVENT", "ev-outlook")];

    setFlags({ outlook: false });
    expect(await withoutHiddenCalendarItems("u1", outlookOnly)).toEqual([]);
    setFlags({ outlook: true });
    expect(ids(await withoutHiddenCalendarItems("u1", outlookOnly))).toEqual(["a-outlook"]);
  });

  it("an item of a linked Google event follows the linked sync flag", async () => {
    const linkedOnly = [item("a-glinked", "CALENDAR_EVENT", "ev-glinked")];

    setFlags({ linked: false });
    expect(await withoutHiddenCalendarItems("u1", linkedOnly)).toEqual([]);
    setFlags({ linked: true });
    expect(ids(await withoutHiddenCalendarItems("u1", linkedOnly))).toEqual(["a-glinked"]);
  });

  it("every other source passes untouched, with no lookup at all", async () => {
    const others = [
      item("e", "EMAIL", "m1"),
      item("t", "TASK", "t1"),
      item("c", "COMMITMENT", "c1"),
    ];

    expect(await withoutHiddenCalendarItems("u1", others)).toEqual(others);
    expect(prisma.calendarEvent.findMany).not.toHaveBeenCalled();
  });

  it("looks every event up in ONE query, scoped to the user, however many items there are", async () => {
    setFlags({ linked: true, outlook: true });

    await withoutHiddenCalendarItems("u1", [
      ...calendarItems(),
      item("a-primary-2", "CALENDAR_EVENT", "ev-primary"),
      item("e", "EMAIL", "m1"),
    ]);

    expect(prisma.calendarEvent.findMany).toHaveBeenCalledTimes(1);
    const where = vi.mocked(prisma.calendarEvent.findMany).mock.calls[0]?.[0] as {
      where: { userId: string; id: { in: string[] } };
    };
    expect(where.where.userId).toBe("u1");
    expect([...where.where.id.in].sort()).toEqual(["ev-glinked", "ev-outlook", "ev-primary"]);
  });

  it("drops an item whose event no longer exists, as the inbox summary does", async () => {
    setFlags({ linked: true, outlook: true });
    state.events = [event("ev-primary", "GOOGLE", null)];

    expect(ids(await withoutHiddenCalendarItems("u1", calendarItems()))).toEqual(["a-primary"]);
  });

  it("never lets another user's event make an item visible", async () => {
    setFlags({ linked: true, outlook: true });
    state.events = [event("ev-outlook", "OUTLOOK", "acct-out", "someone-else")];

    expect(
      await withoutHiddenCalendarItems("u1", [item("a-outlook", "CALENDAR_EVENT", "ev-outlook")]),
    ).toEqual([]);
  });

  it("keeps the order, and returns a new array without touching the input", async () => {
    setFlags({ linked: true, outlook: true });
    const input = Object.freeze([...calendarItems()]);

    const out = await withoutHiddenCalendarItems("u1", input);

    expect(out).not.toBe(input);
    expect(ids(out)).toEqual(["a-primary", "a-glinked", "a-outlook"]);
  });
});

describe("the briefing's needs-attention list drops the title of a hidden calendar event", () => {
  const NOW = new Date("2026-10-01T03:00:00.000Z");
  const row = (id: string, source: string, sourceId: string, title: string) => ({
    id,
    source,
    sourceId,
    title,
    tierReason: null,
  });
  async function shown(): Promise<string[]> {
    const structure = await buildBriefingStructure("u1", NOW);
    return structure.attention.map((a) => a.action);
  }

  it("OUTLOOK: the title is gone with the flags OFF and back with them ON", async () => {
    state.pushItems = [
      row("p1", "EMAIL", "m1", "Reply to Ann"),
      row("p2", "CALENDAR_EVENT", "ev-outlook", "Layoff planning"),
      row("p3", "CALENDAR_EVENT", "ev-primary", "Standup"),
    ];

    setFlags({ outlook: false });
    const off = await shown();
    setFlags({ outlook: true });
    const on = await shown();

    expect(off.join("|")).not.toContain("Layoff planning");
    expect(off).toHaveLength(2);
    expect(on.join("|")).toContain("Layoff planning");
    expect(on).toHaveLength(3);
  });

  it("a linked Google event: the title follows the linked sync flag", async () => {
    state.pushItems = [row("p1", "CALENDAR_EVENT", "ev-glinked", "Quarterly review")];

    setFlags({ linked: false });
    expect(await shown()).toEqual([]);
    setFlags({ linked: true });
    expect((await shown()).join("|")).toContain("Quarterly review");
  });

  it("primary Google behaviour is identical: items of the primary calendar and of other sources stay, in order", async () => {
    state.pushItems = [
      row("p1", "CALENDAR_EVENT", "ev-primary", "Standup"),
      row("p2", "EMAIL", "m1", "Reply to Ann"),
      row("p3", "TASK", "t1", "File taxes"),
    ];

    const out = await shown();

    expect(out).toHaveLength(3);
    expect(out[0]).toContain("Standup");
    expect(out[1]).toContain("Reply to Ann");
    expect(out[2]).toContain("File taxes");
  });

  it("still shows the top three when hidden items would have taken a slot", async () => {
    state.pushItems = [
      row("p1", "CALENDAR_EVENT", "ev-outlook", "Hidden one"),
      row("p2", "CALENDAR_EVENT", "ev-glinked", "Hidden two"),
      row("p3", "EMAIL", "m1", "Visible one"),
      row("p4", "EMAIL", "m2", "Visible two"),
      row("p5", "EMAIL", "m3", "Visible three"),
      row("p6", "EMAIL", "m4", "Visible four"),
    ];

    const out = await shown();

    expect(out).toHaveLength(3);
    expect(out.join("|")).not.toContain("Hidden");
    expect(out[0]).toContain("Visible one");
  });

  it("asks the database for more than three, so the filter cannot starve the list", async () => {
    await shown();

    const args = vi.mocked(prisma.attentionItem.findMany).mock.calls[0]?.[0] as {
      take: number;
      select: Record<string, boolean>;
    };
    expect(args.take).toBeGreaterThan(3);
    expect(args.select).toMatchObject({ title: true, source: true, sourceId: true });
  });
});

// Every module that reads AttentionItem rows, and why none of them can show the title of
// a hidden calendar event. A new reader fails here until it is classified.
describe("every AttentionItem reader is accounted for", () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const READ =
    /[aA]ttentionItem\s*\.\s*(findMany|findFirst|findUnique|count|aggregate|groupBy|findFirstOrThrow|findUniqueOrThrow)\b/;

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sources(full);
      return entry.name.endsWith(".ts") ? [full] : [];
    });
  }

  const readers = sources(srcDir)
    .map((full) => ({ path: relative(srcDir, full), text: readFileSync(full, "utf8") }))
    .filter((f) => READ.test(f.text))
    .map((f) => f.path)
    .sort();

  // Read EMAIL (or COMMITMENT) items only, by id, or count: no calendar title can come out.
  const NOT_CALENDAR = [
    "agentcore/auto-mode-candidates.ts",
    "judge/attention-aging.ts",
    "judge/calibration-snapshot.ts",
    "judge/email-firewall.ts",
    "judge/email-lanes.ts",
    "judge/fallback-rejudge.ts",
    "judge/judge-context.ts",
    "judge/label-correction.ts",
    "judge/rejudge-open-items.ts",
    "learning/learned-rule-store.ts",
    "mcp/set-tier.ts",
    "pim/briefing.ts",
    "pim/focus-digest.ts", // a count of arrivals, no title
    "routes/commitments.ts",
  ];
  // Show items of every source, so they drop the ones whose calendar event is hidden.
  const FILTERS_CALENDAR_ITEMS = ["pim/briefing-structure.ts", "pim/inbox-summary.ts"];

  it("finds the readers (so this guard cannot pass by scanning nothing)", () => {
    expect(readers.length).toBeGreaterThan(10);
  });

  it("every reader is classified", () => {
    const accounted = new Set([...NOT_CALENDAR, ...FILTERS_CALENDAR_ITEMS]);
    expect(readers.filter((path) => !accounted.has(path))).toEqual([]);
  });

  it("the lists name no module that has stopped reading items", () => {
    expect(
      [...NOT_CALENDAR, ...FILTERS_CALENDAR_ITEMS].filter((p) => !readers.includes(p)),
    ).toEqual([]);
  });

  it.each(FILTERS_CALENDAR_ITEMS)("%s applies the calendar scope to the items it shows", (path) => {
    const text = readFileSync(join(srcDir, path), "utf8");
    expect(text).toMatch(/withoutHiddenCalendarItems\(|calendarSourceScope\(\)/);
  });
});
