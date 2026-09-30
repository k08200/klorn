/**
 * C2b: an event deleted or cancelled in Google is removed from Klorn on the next
 * sync. The sync's own listing stays exactly as it was; cancellations come from a
 * SEPARATE call (session.listCancelledEvents), because cancelled events listed
 * alongside live ones would spend the 100-event cap and push live events out of
 * the window. A row that is merely absent from the listing is kept, since the cap
 * can truncate the window. Removal is the row's whole identity (user, GOOGLE,
 * source, id) plus its attention items, in one transaction; a failing
 * cancellation call never fails the sync.
 *
 * The prisma double below filters on the `where` it is given, so scoping mistakes
 * (user, provider, source) change what survives instead of hiding in a call log.
 * Its top-level calendarEvent has no findMany/deleteMany: only the transaction
 * client does, which is how the test holds the removal to one transaction.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  type Rec = Record<string, unknown>;
  const state = { events: [] as Rec[], attention: [] as Rec[] };
  const matches = (row: Rec, where: Rec): boolean =>
    Object.entries(where).every(([key, want]) => {
      if (key === "OR") return (want as Rec[]).some((clause) => matches(row, clause));
      if (want && typeof want === "object" && "in" in want) {
        return (want as { in: unknown[] }).in.includes(row[key]);
      }
      return row[key] === want;
    });
  const tx = {
    calendarEvent: {
      findMany: vi.fn(async ({ where }: { where: Rec }) =>
        state.events.filter((row) => matches(row, where)),
      ),
      deleteMany: vi.fn(async ({ where }: { where: Rec }) => {
        const gone = state.events.filter((row) => matches(row, where));
        state.events = state.events.filter((row) => !gone.includes(row));
        return { count: gone.length };
      }),
    },
    attentionItem: {
      updateMany: vi.fn(async ({ where, data }: { where: Rec; data: Rec }) => {
        let count = 0;
        state.attention = state.attention.map((row) => {
          if (!matches(row, where)) return row;
          count += 1;
          return { ...row, ...data };
        });
        return { count };
      }),
    },
  };
  const prisma = {
    calendarEvent: { upsert: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { state, tx, prisma, captureError: vi.fn() };
});

vi.mock("../db.js", () => ({
  prisma: h.prisma,
  db: h.prisma,
  INTERACTIVE_TX_OPTIONS: { maxWait: 10_000, timeout: 15_000 },
}));
vi.mock("../mail/gmail.js", () => ({
  getAuthedClient: vi.fn(async () => ({})),
  buildLinkedCalendarClient: vi.fn(),
  isGoogleAuthError: vi.fn(() => false),
  markLinkedCalendarForReconnect: vi.fn(async () => {}),
}));
vi.mock("../sentry.js", () => ({ captureError: h.captureError }));

import { _resetCancelledScanStateForTests } from "../pim/calendar-cancellation.js";
import type {
  CalendarSession,
  CancelledEventsResult,
  ProviderCalendarEvent,
} from "../pim/calendar-providers/types.js";
import { syncLinkedCalendarWindow, syncPrimaryCalendarWindow } from "../pim/calendar-sync.js";

const NOW = new Date("2026-09-30T05:00:00.000Z");
const ZONE = "Asia/Seoul";
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const later = (ms: number) => new Date(NOW.getTime() + ms);

function live(
  externalId: string,
  over: Partial<ProviderCalendarEvent> = {},
): ProviderCalendarEvent {
  return {
    externalId,
    summary: "Planning",
    description: null,
    location: null,
    meetingLink: null,
    start: "2026-10-02T09:00:00+09:00",
    end: "2026-10-02T10:00:00+09:00",
    allDay: false,
    startTime: new Date("2026-10-02T00:00:00.000Z"),
    endTime: new Date("2026-10-02T01:00:00.000Z"),
    ...over,
  };
}

interface SessionOptions {
  live?: ProviderCalendarEvent[];
  /** What the cancellation call answers, an error it throws, or null for a provider without one. */
  cancelled?: string[] | CancelledEventsResult | Error | null;
}

function makeSession(options: SessionOptions = {}) {
  const { live: liveEvents = [], cancelled = [] } = options;
  const listEvents = vi.fn(async (..._args: unknown[]) => liveEvents);
  const listCancelledEvents = vi.fn(async (..._args: unknown[]) => {
    if (cancelled instanceof Error) throw cancelled;
    if (Array.isArray(cancelled)) return { externalIds: cancelled, truncated: false };
    return cancelled ?? { externalIds: [], truncated: false };
  });
  const session = {
    provider: "GOOGLE",
    listEvents,
    ...(cancelled === null ? {} : { listCancelledEvents }),
  } as unknown as CalendarSession;
  return { session, listEvents, listCancelledEvents };
}

let nextId = 0;
function eventRow(
  externalId: string | null,
  over: {
    userId?: string;
    provider?: string;
    sourceKey?: string;
    googleId?: string | null;
  } = {},
) {
  nextId += 1;
  const row = {
    id: `row-${nextId}`,
    userId: "u1",
    provider: externalId === null ? "LOCAL" : "GOOGLE",
    sourceKey: "primary",
    externalId,
    googleId: null as string | null,
    ...over,
  };
  h.state.events.push(row);
  return row;
}

function attentionFor(
  eventId: string,
  over: { status?: string; userId?: string; source?: string } = {},
) {
  nextId += 1;
  const item = {
    id: `att-${nextId}`,
    userId: "u1",
    source: "CALENDAR_EVENT",
    sourceId: eventId,
    status: "OPEN",
    resolvedAt: null as Date | null,
    ...over,
  };
  h.state.attention.push(item);
  return item;
}

const eventIds = () => h.state.events.map((row) => row.id);
const attentionById = (id: string) => h.state.attention.find((row) => row.id === id);
const scanArgs = (scan: { mock: { calls: unknown[][] } }, call = 0) =>
  scan.mock.calls[call]?.[0] as { timeMin: string; timeMax: string; updatedMin: string };

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  h.state.events = [];
  h.state.attention = [];
  nextId = 0;
  _resetCancelledScanStateForTests();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("the sync's own listing", () => {
  it("is unchanged: next 30 days, 100 events, the user's zone, nothing about cancelled events", async () => {
    const { session, listEvents } = makeSession();

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(listEvents).toHaveBeenCalledTimes(1);
    expect(listEvents.mock.calls[0]?.[0]).toStrictEqual({
      timeMin: "2026-09-30T05:00:00.000Z",
      timeMax: "2026-10-30T05:00:00.000Z",
      maxResults: 100,
      timeZone: ZONE,
    });
  });

  it("is not affected by more than 100 cancellations: live events are written as before", async () => {
    const manyCancelled = Array.from({ length: 150 }, (_, i) => `gone-${i}`);
    const { session, listEvents } = makeSession({
      live: [live("g-1"), live("g-2")],
      cancelled: manyCancelled,
    });

    const written = await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(written).toBe(2);
    expect(listEvents).toHaveBeenCalledTimes(1);
    expect(listEvents.mock.calls[0]?.[0]).toMatchObject({ maxResults: 100 });
    expect(h.prisma.calendarEvent.upsert).toHaveBeenCalledTimes(2);
  });

  it("writes live events exactly as before (by googleId), counting only them", async () => {
    const { session } = makeSession({ live: [live("g-1"), live("g-3")], cancelled: ["g-2"] });

    const written = await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(written).toBe(2);
    const keys = h.prisma.calendarEvent.upsert.mock.calls.map(
      (c) => (c as unknown as [{ where: { userId_googleId: { googleId: string } } }])[0].where,
    );
    expect(keys.map((k) => k.userId_googleId.googleId)).toEqual(["g-1", "g-3"]);
  });
});

describe("primary sync: events cancelled in Google", () => {
  it("deletes the cancelled event's row and resolves its attention items", async () => {
    const gone = eventRow("g-gone");
    const kept = eventRow("g-kept");
    const goneItem = attentionFor(gone.id);
    const keptItem = attentionFor(kept.id);
    const { session } = makeSession({ live: [live("g-kept")], cancelled: ["g-gone"] });

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(eventIds()).toEqual([kept.id]);
    expect(attentionById(goneItem.id)).toMatchObject({ status: "RESOLVED", resolvedAt: NOW });
    expect(attentionById(keptItem.id)).toMatchObject({ status: "OPEN", resolvedAt: null });
  });

  it("keeps an event that is merely absent from the listing (the 100-event cap can truncate)", async () => {
    const absent = eventRow("g-absent");
    const absentItem = attentionFor(absent.id);
    const { session } = makeSession({ live: [live("g-other")], cancelled: [] });

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(eventIds()).toEqual([absent.id]);
    expect(attentionById(absentItem.id)).toMatchObject({ status: "OPEN" });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("never touches a LOCAL row, nor a row Google did not name", async () => {
    const local = eventRow(null);
    const localItem = attentionFor(local.id);
    const outside = eventRow("g-outside-window");
    // An empty id must not match the NULL ids of LOCAL rows.
    const { session } = makeSession({ cancelled: ["", "g-not-ours"] });

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(eventIds()).toEqual([local.id, outside.id]);
    expect(attentionById(localItem.id)).toMatchObject({ status: "OPEN" });
  });

  it("never touches another user's row that has the same Google event id", async () => {
    const mine = eventRow("shared-invite");
    const theirs = eventRow("shared-invite", { userId: "u2" });
    const theirsItem = attentionFor(theirs.id, { userId: "u2" });
    const { session } = makeSession({ cancelled: ["shared-invite"] });

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(eventIds()).toEqual([theirs.id]);
    expect(eventIds()).not.toContain(mine.id);
    expect(attentionById(theirsItem.id)).toMatchObject({ status: "OPEN" });
  });

  it("never touches another provider's row that happens to share the source and id", async () => {
    const other = eventRow("g-gone", { provider: "OUTLOOK" });
    const { session } = makeSession({ cancelled: ["g-gone"] });

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(eventIds()).toEqual([other.id]);
  });

  it("removes only the cancelled instance of a recurring event", async () => {
    const monday = eventRow("standup_20261005T000000Z");
    const tuesday = eventRow("standup_20261006T000000Z");
    const { session } = makeSession({
      live: [live("standup_20261006T000000Z")],
      cancelled: ["standup_20261005T000000Z"],
    });

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(eventIds()).toEqual([tuesday.id]);
    expect(eventIds()).not.toContain(monday.id);
  });

  it("leaves an attention item the user already dismissed as they left it", async () => {
    const gone = eventRow("g-gone");
    const dismissed = attentionFor(gone.id, { status: "DISMISSED" });
    const snoozed = attentionFor(gone.id, { status: "SNOOZED" });
    const { session } = makeSession({ cancelled: ["g-gone"] });

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(attentionById(dismissed.id)).toMatchObject({ status: "DISMISSED", resolvedAt: null });
    expect(attentionById(snoozed.id)).toMatchObject({ status: "RESOLVED", resolvedAt: NOW });
  });

  it("only resolves CALENDAR_EVENT items, even when another source reuses the id", async () => {
    const gone = eventRow("g-gone");
    const foreign = attentionFor(gone.id, { source: "TASK" });
    const { session } = makeSession({ cancelled: ["g-gone"] });

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(attentionById(foreign.id)).toMatchObject({ status: "OPEN" });
  });

  it("does all the removals of one sync in a single transaction", async () => {
    eventRow("g-1");
    eventRow("g-2");
    eventRow("g-3");
    const { session } = makeSession({ live: [live("g-3")], cancelled: ["g-1", "g-2"] });

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(h.tx.calendarEvent.deleteMany).toHaveBeenCalledTimes(1);
    expect(h.state.events.map((row) => row.externalId)).toEqual(["g-3"]);
  });

  it("is a no-op when the cancelled event has no local row (a repeat sync)", async () => {
    const { session } = makeSession({ cancelled: ["g-already-gone"] });

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(h.tx.attentionItem.updateMany).not.toHaveBeenCalled();
    expect(h.tx.calendarEvent.deleteMany).not.toHaveBeenCalled();
  });
});

describe("primary rows written by the previous release (externalId NULL)", () => {
  it("are matched by googleId, and their attention items resolved", async () => {
    const legacy = eventRow(null, { provider: "GOOGLE", googleId: "g-legacy" });
    const legacyItem = attentionFor(legacy.id);
    const { session } = makeSession({ cancelled: ["g-legacy"] });

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(eventIds()).toEqual([]);
    expect(attentionById(legacyItem.id)).toMatchObject({ status: "RESOLVED", resolvedAt: NOW });
  });

  it("are matched by googleId only when externalId is NULL", async () => {
    const restamped = eventRow("g-other", { googleId: "g-x" });
    const { session } = makeSession({ cancelled: ["g-x"] });

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(eventIds()).toEqual([restamped.id]);
  });

  it("are another user's own, never removed by my cancellation", async () => {
    const theirs = eventRow(null, { provider: "GOOGLE", googleId: "g-legacy", userId: "u2" });
    const { session } = makeSession({ cancelled: ["g-legacy"] });

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(eventIds()).toEqual([theirs.id]);
  });

  it("are the primary's alone: a linked row is never matched by googleId", async () => {
    const odd = eventRow(null, { provider: "GOOGLE", sourceKey: "acct-work", googleId: "g-x" });
    const { session } = makeSession({ cancelled: ["g-x"] });

    await syncLinkedCalendarWindow(session, "u1", "acct-work", ZONE, NOW);

    expect(eventIds()).toEqual([odd.id]);
  });

  it("are never matched by a linked account's cancellation", async () => {
    const legacy = eventRow(null, { provider: "GOOGLE", googleId: "g-legacy" });
    const { session } = makeSession({ cancelled: ["g-legacy"] });

    await syncLinkedCalendarWindow(session, "u1", "acct-work", ZONE, NOW);

    expect(eventIds()).toEqual([legacy.id]);
  });
});

describe("linked sync: events cancelled in a linked Google calendar", () => {
  it("removes only that account's row, never another account's or the primary's with the same id", async () => {
    const work = eventRow("g-shared", { sourceKey: "acct-work" });
    const school = eventRow("g-shared", { sourceKey: "acct-school" });
    const primary = eventRow("g-shared", { sourceKey: "primary" });
    const workItem = attentionFor(work.id);
    const schoolItem = attentionFor(school.id);
    const primaryItem = attentionFor(primary.id);
    const { session } = makeSession({ cancelled: ["g-shared"] });

    await syncLinkedCalendarWindow(session, "u1", "acct-work", ZONE, NOW);

    expect(eventIds()).toEqual([school.id, primary.id]);
    expect(attentionById(workItem.id)).toMatchObject({ status: "RESOLVED", resolvedAt: NOW });
    expect(attentionById(schoolItem.id)).toMatchObject({ status: "OPEN" });
    expect(attentionById(primaryItem.id)).toMatchObject({ status: "OPEN" });
  });

  it("a primary sync never removes a linked account's row", async () => {
    const linked = eventRow("g-shared", { sourceKey: "acct-work" });
    const primary = eventRow("g-shared", { sourceKey: "primary" });
    const { session } = makeSession({ cancelled: ["g-shared"] });

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(eventIds()).toEqual([linked.id]);
    expect(eventIds()).not.toContain(primary.id);
  });

  it("writes live events as before and keeps an absent one", async () => {
    const absent = eventRow("g-absent", { sourceKey: "acct-work" });
    const { session } = makeSession({ live: [live("g-live")], cancelled: ["g-gone"] });

    const written = await syncLinkedCalendarWindow(session, "u1", "acct-work", ZONE, NOW);

    expect(written).toBe(1);
    expect(h.prisma.calendarEvent.upsert).toHaveBeenCalledTimes(1);
    expect(eventIds()).toEqual([absent.id]);
  });
});

describe("the cancellation call's window", () => {
  it("covers the sync window and, on a first scan, reaches back 7 days", async () => {
    const { session, listCancelledEvents } = makeSession();

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(listCancelledEvents).toHaveBeenCalledTimes(1);
    expect(scanArgs(listCancelledEvents)).toStrictEqual({
      timeMin: "2026-09-30T05:00:00.000Z",
      timeMax: "2026-10-30T05:00:00.000Z",
      updatedMin: new Date(NOW.getTime() - 7 * DAY).toISOString(),
    });
  });

  it("after a successful scan, reaches back only to that scan minus a 30 minute margin", async () => {
    const { session, listCancelledEvents } = makeSession();

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);
    await syncPrimaryCalendarWindow(session, "u1", ZONE, later(15 * MIN));

    expect(scanArgs(listCancelledEvents, 1).updatedMin).toBe(
      new Date(NOW.getTime() - 30 * MIN).toISOString(),
    );
  });

  it("never reaches back further than 7 days, however long ago the last scan was", async () => {
    const { session, listCancelledEvents } = makeSession();

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);
    const afterGap = later(10 * DAY);
    await syncPrimaryCalendarWindow(session, "u1", ZONE, afterGap);

    expect(scanArgs(listCancelledEvents, 1).updatedMin).toBe(
      new Date(afterGap.getTime() - 7 * DAY).toISOString(),
    );
  });

  it("does not move the last-scan time when the scan fails", async () => {
    const ok = makeSession();
    const broken = makeSession({ cancelled: new Error("quota") });

    await syncPrimaryCalendarWindow(ok.session, "u1", ZONE, NOW);
    await syncPrimaryCalendarWindow(broken.session, "u1", ZONE, later(15 * MIN));
    await syncPrimaryCalendarWindow(ok.session, "u1", ZONE, later(30 * MIN));

    expect(scanArgs(ok.listCancelledEvents, 1).updatedMin).toBe(
      new Date(NOW.getTime() - 30 * MIN).toISOString(),
    );
  });

  it("does not move the last-scan time when the scan was truncated", async () => {
    const cut = makeSession({ cancelled: { externalIds: ["a"], truncated: true } });
    const ok = makeSession();

    await syncPrimaryCalendarWindow(cut.session, "u1", ZONE, NOW);
    await syncPrimaryCalendarWindow(ok.session, "u1", ZONE, later(15 * MIN));

    expect(scanArgs(ok.listCancelledEvents).updatedMin).toBe(
      new Date(later(15 * MIN).getTime() - 7 * DAY).toISOString(),
    );
  });

  it("keeps each account's last scan apart", async () => {
    const primary = makeSession();
    const work = makeSession();

    await syncPrimaryCalendarWindow(primary.session, "u1", ZONE, NOW);
    await syncLinkedCalendarWindow(work.session, "u1", "acct-work", ZONE, later(15 * MIN));

    expect(scanArgs(work.listCancelledEvents).updatedMin).toBe(
      new Date(later(15 * MIN).getTime() - 7 * DAY).toISOString(),
    );
  });
});

describe("a failing cancellation step never fails the sync", () => {
  it("still upserts and answers when the cancellation call throws, logging once and never to Sentry", async () => {
    const { session } = makeSession({ live: [live("g-1")], cancelled: new Error("quota") });

    const written = await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);
    const writtenAgain = await syncPrimaryCalendarWindow(session, "u1", ZONE, later(15 * MIN));

    expect([written, writtenAgain]).toEqual([1, 1]);
    expect(h.prisma.calendarEvent.upsert).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("quota");
    expect(h.captureError).not.toHaveBeenCalled();
  });

  it("logs again after a scan succeeded and a later one fails", async () => {
    const broken = makeSession({ cancelled: new Error("quota") });
    const ok = makeSession();

    await syncPrimaryCalendarWindow(broken.session, "u1", ZONE, NOW);
    await syncPrimaryCalendarWindow(ok.session, "u1", ZONE, later(15 * MIN));
    await syncPrimaryCalendarWindow(broken.session, "u1", ZONE, later(30 * MIN));

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("still answers when the removal transaction fails", async () => {
    eventRow("g-gone");
    h.prisma.$transaction.mockRejectedValueOnce(new Error("db down"));
    const { session } = makeSession({ live: [live("g-1")], cancelled: ["g-gone"] });

    const written = await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(written).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(h.captureError).not.toHaveBeenCalled();
  });

  it("syncs a provider that has no cancellation call exactly as before", async () => {
    const { session } = makeSession({ live: [live("g-1")], cancelled: null });

    const written = await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(written).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("a truncated cancellation scan", () => {
  it("warns once, and still removes the rows it did find", async () => {
    const gone = eventRow("g-gone");
    const cut = makeSession({ cancelled: { externalIds: ["g-gone"], truncated: true } });

    await syncPrimaryCalendarWindow(cut.session, "u1", ZONE, NOW);
    await syncPrimaryCalendarWindow(cut.session, "u1", ZONE, later(15 * MIN));

    expect(eventIds()).not.toContain(gone.id);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("truncated");
    expect(h.captureError).not.toHaveBeenCalled();
  });
});
