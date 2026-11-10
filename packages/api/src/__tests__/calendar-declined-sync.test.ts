/**
 * A Google invitation the user declined is still returned by events.list, with the
 * user's own attendee entry (`self: true`) at `responseStatus: "declined"`. Synced
 * as a row it reached every row reader: the briefing, the meeting reminders, the
 * conflict checks. Behind CALENDAR_HIDE_DECLINED_ENABLED (off by default) a sync
 * writes no row for it and removes the row an earlier sync wrote, resolving the
 * row's open attention items, in the account's own scope only. Off, a sync is
 * exactly what it was. Outlook and CalDAV do not report it yet (plan, C3 limit 8).
 *
 * The rows live in the strict fake database, so every `where` is evaluated against
 * the real schema.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "./helpers/fake-db.js";

const h = vi.hoisted(() => ({
  db: null as unknown,
  eventsList: vi.fn(),
  captureError: vi.fn(),
}));

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => h.db as FakeDb);
  return {
    prisma,
    db: prisma,
    INTERACTIVE_TX_OPTIONS: { maxWait: 10_000, timeout: 15_000 },
  };
});
vi.mock("googleapis", () => ({
  google: { calendar: () => ({ events: { list: h.eventsList } }) },
}));
vi.mock("../sentry.js", () => ({ captureError: h.captureError }));

import { googleSessionFromClient } from "../pim/calendar-providers/google.js";
import type { CalendarSession, ProviderCalendarEvent } from "../pim/calendar-providers/types.js";
import {
  _resetDeclinedRemovalReportsForTests,
  syncLinkedCalendarWindow,
  syncPrimaryCalendarWindow,
} from "../pim/calendar-sync.js";

const FLAG = "CALENDAR_HIDE_DECLINED_ENABLED";
const NOW = new Date("2026-10-15T00:00:00.000Z");
const ZONE = "Asia/Seoul";
const ME = { email: "me@example.com", self: true };

function googleItem(id: string, attendees?: Array<Record<string, unknown>>) {
  return {
    id,
    summary: `Event ${id}`,
    start: { dateTime: "2026-10-16T10:00:00+09:00" },
    end: { dateTime: "2026-10-16T11:00:00+09:00" },
    ...(attendees ? { attendees } : {}),
  };
}

function live(id: string, declinedBySelf: boolean): ProviderCalendarEvent {
  return {
    externalId: id,
    summary: `Event ${id}`,
    description: null,
    location: null,
    meetingLink: null,
    start: "2026-10-16T10:00:00+09:00",
    end: "2026-10-16T11:00:00+09:00",
    allDay: false,
    startTime: new Date("2026-10-16T01:00:00.000Z"),
    endTime: new Date("2026-10-16T02:00:00.000Z"),
    declinedBySelf,
  };
}

function session(events: ProviderCalendarEvent[], provider = "GOOGLE"): CalendarSession {
  return { provider, listEvents: vi.fn(async () => events) } as unknown as CalendarSession;
}

function row(id: string, externalId: string, sourceKey = "primary", sourceAccountId?: string) {
  return {
    id,
    userId: "u1",
    title: "Board meeting",
    startTime: new Date("2026-10-16T01:00:00.000Z"),
    endTime: new Date("2026-10-16T02:00:00.000Z"),
    provider: "GOOGLE",
    externalId,
    googleId: sourceKey === "primary" ? externalId : null,
    sourceKey,
    sourceAccountId: sourceAccountId ?? null,
  };
}

function attention(id: string, sourceId: string) {
  return {
    id,
    userId: "u1",
    source: "CALENDAR_EVENT",
    sourceId,
    status: "OPEN",
    type: "MEETING_PREP",
    title: "Prep",
  };
}

let db: FakeDb;
const saved = process.env[FLAG];
const tables = () => db.tables as Record<string, Array<Record<string, unknown>>>;
const externalIds = () =>
  tables()
    .calendarEvent.map((r) => r.externalId)
    .sort();

beforeEach(() => {
  vi.clearAllMocks();
  _resetDeclinedRemovalReportsForTests();
  delete process.env[FLAG];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
  vi.restoreAllMocks();
});

function seed(
  events: Array<Record<string, unknown>>,
  items: Array<Record<string, unknown>> = [],
  hooks: Parameters<typeof createFakeDb>[1] = {},
) {
  db = createFakeDb({ calendarEvent: events, attentionItem: items }, hooks);
  h.db = db;
}

describe("the Google mapping says whether the user declined", () => {
  it.each([
    ["the user's own entry declined", [{ ...ME, responseStatus: "declined" }], true],
    [
      "the user accepted, another attendee declined",
      [
        { ...ME, responseStatus: "accepted" },
        { email: "x@example.com", responseStatus: "declined" },
      ],
      false,
    ],
    ["the user has not answered", [{ ...ME, responseStatus: "needsAction" }], false],
    [
      "a declined entry that is not the user's",
      [{ email: "me@example.com", responseStatus: "declined" }],
      false,
    ],
    ["no attendee list (the user's own event)", undefined, false],
    ["the user's own entry with no answer at all", [{ ...ME }], false],
    [
      "a large meeting whose list omits the user (attendeesOmitted)",
      [{ email: "x@example.com", responseStatus: "declined" }],
      false,
    ],
  ])("%s", async (_name, attendees, declined) => {
    h.eventsList.mockResolvedValue({ data: { items: [googleItem("g1", attendees)] } });
    const s = googleSessionFromClient({} as never);
    const [event] = await s.listEvents({
      timeMin: NOW.toISOString(),
      maxResults: 10,
      timeZone: ZONE,
    });
    expect(event?.declinedBySelf).toBe(declined);
  });
});

describe("syncPrimaryCalendarWindow and a declined invitation", () => {
  it("with the flag off, syncs it exactly as before", async () => {
    seed([row("r-old", "g-declined")], [attention("a1", "r-old")]);
    const written = await syncPrimaryCalendarWindow(
      session([live("g-declined", true), live("g-kept", false)]),
      "u1",
      ZONE,
      NOW,
    );
    expect(written).toBe(2);
    expect(externalIds()).toEqual(["g-declined", "g-kept"]);
    expect(tables().attentionItem[0]?.status).toBe("OPEN");
  });

  it("with the flag on, writes no row for it and removes the earlier one", async () => {
    process.env[FLAG] = "true";
    seed([row("r-old", "g-declined")], [attention("a1", "r-old")]);
    const written = await syncPrimaryCalendarWindow(
      session([live("g-declined", true), live("g-kept", false), live("g-new-declined", true)]),
      "u1",
      ZONE,
      NOW,
    );
    expect(written).toBe(1);
    expect(externalIds()).toEqual(["g-kept"]);
    expect(tables().attentionItem[0]).toMatchObject({ status: "RESOLVED", resolvedAt: NOW });
  });

  it("never reaches another user's row or a linked account's row with the same id", async () => {
    process.env[FLAG] = "true";
    seed([
      { ...row("r-other-user", "g-declined"), userId: "u2" },
      row("r-linked", "g-declined", "acct-work", "acct-work"),
    ]);
    await syncPrimaryCalendarWindow(session([live("g-declined", true)]), "u1", ZONE, NOW);
    expect(
      tables()
        .calendarEvent.map((r) => r.id)
        .sort(),
    ).toEqual(["r-linked", "r-other-user"]);
  });

  it("a failing removal is reported and never fails the sync", async () => {
    process.env[FLAG] = "true";
    seed([row("r-old", "g-declined")], [], {
      beforeUpdateMany: (model) => {
        if (model === "attentionItem") throw new Error("db down");
      },
    });
    await expect(
      syncPrimaryCalendarWindow(
        session([live("g-declined", true), live("g-kept", false)]),
        "u1",
        ZONE,
        NOW,
      ),
    ).resolves.toBe(1);
    expect(h.captureError).toHaveBeenCalledTimes(1);
    expect(externalIds()).toEqual(["g-declined", "g-kept"]);
  });

  it("reports a lasting failure once per account, and again after a success", async () => {
    process.env[FLAG] = "true";
    let failing = true;
    seed([row("r-old", "g-declined")], [], {
      beforeUpdateMany: (model) => {
        if (failing && model === "attentionItem") throw new Error("db down");
      },
    });
    const sync = () =>
      syncPrimaryCalendarWindow(session([live("g-declined", true)]), "u1", ZONE, NOW);
    await sync();
    await sync();
    expect(h.captureError).toHaveBeenCalledTimes(1);
    failing = false;
    await sync();
    expect(externalIds()).toEqual([]);
    failing = true;
    tables().calendarEvent.push(row("r-again", "g-declined"));
    await sync();
    expect(h.captureError).toHaveBeenCalledTimes(2);
  });

  it("removes a row the previous release wrote without an externalId (matched by googleId)", async () => {
    process.env[FLAG] = "true";
    seed([{ ...row("r-legacy", "g-declined"), externalId: null }]);
    await syncPrimaryCalendarWindow(session([live("g-declined", true)]), "u1", ZONE, NOW);
    expect(tables().calendarEvent).toEqual([]);
  });

  it("a declined instance leaves the series' other instances", async () => {
    process.env[FLAG] = "true";
    seed([
      row("r-mon", "standup_20261016T010000Z"),
      row("r-tue", "standup_20261017T010000Z"),
      row("r-series", "standup"),
    ]);
    await syncPrimaryCalendarWindow(
      session([live("standup_20261016T010000Z", true), live("standup_20261017T010000Z", false)]),
      "u1",
      ZONE,
      NOW,
    );
    expect(externalIds()).toEqual(["standup", "standup_20261017T010000Z"]);
  });

  it("never reaches another provider's row with the same id", async () => {
    process.env[FLAG] = "true";
    seed([{ ...row("r-outlook", "g-declined", "acct-o", "acct-o"), provider: "OUTLOOK" }]);
    await syncPrimaryCalendarWindow(session([live("g-declined", true)]), "u1", ZONE, NOW);
    expect(tables().calendarEvent.map((r) => r.id)).toEqual(["r-outlook"]);
  });

  it("an attention item the user already dismissed keeps its outcome", async () => {
    process.env[FLAG] = "true";
    seed([row("r-old", "g-declined")], [{ ...attention("a1", "r-old"), status: "DISMISSED" }]);
    await syncPrimaryCalendarWindow(session([live("g-declined", true)]), "u1", ZONE, NOW);
    expect(tables().attentionItem[0]?.status).toBe("DISMISSED");
  });

  it("an invitation accepted after a decline is written again on the next sync", async () => {
    process.env[FLAG] = "true";
    seed([row("r-old", "g-flip")]);
    await syncPrimaryCalendarWindow(session([live("g-flip", true)]), "u1", ZONE, NOW);
    expect(externalIds()).toEqual([]);
    const written = await syncPrimaryCalendarWindow(
      session([live("g-flip", false)]),
      "u1",
      ZONE,
      NOW,
    );
    expect(written).toBe(1);
    expect(externalIds()).toEqual(["g-flip"]);
  });
});

describe("syncLinkedCalendarWindow and a declined invitation", () => {
  it("with the flag on, removes only that account's row", async () => {
    process.env[FLAG] = "true";
    seed([row("r-primary", "g-declined"), row("r-linked", "g-declined", "acct-work", "acct-work")]);
    const written = await syncLinkedCalendarWindow(
      session([live("g-declined", true)]),
      "u1",
      "acct-work",
      ZONE,
      NOW,
    );
    expect(written).toBe(0);
    expect(tables().calendarEvent.map((r) => r.id)).toEqual(["r-primary"]);
  });

  it("leaves a provider other than Google exactly as before", async () => {
    process.env[FLAG] = "true";
    seed([]);
    const written = await syncLinkedCalendarWindow(
      session([live("o-1", true)], "OUTLOOK"),
      "u1",
      "acct-outlook",
      ZONE,
      NOW,
    );
    expect(written).toBe(1);
    expect(externalIds()).toEqual(["o-1"]);
  });
});
