/**
 * C2b: an event deleted or cancelled in Google is removed from Klorn on the next
 * sync. Google only reports a deletion when asked (showDeleted), as an event with
 * status "cancelled" that may carry nothing but its id, so the sync reads that
 * flag and removes the matching row of THAT account (and resolves the attention
 * items mirrored from it) in one transaction. A row that is merely absent from
 * the listing is kept: the 100-event cap can truncate the window.
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
  return { state, tx, prisma };
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
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import type { CalendarSession, ProviderCalendarEvent } from "../pim/calendar-providers/types.js";
import {
  syncLinkedCalendarWindow,
  syncPrimaryCalendarWindow,
  syncQuery,
} from "../pim/calendar-sync.js";

const NOW = new Date("2026-09-30T05:00:00.000Z");
const ZONE = "Asia/Seoul";

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

/** What Google sends for a deleted event: status cancelled and, guaranteed, only the id. */
function cancelled(externalId: string): ProviderCalendarEvent {
  return {
    externalId,
    summary: null,
    description: null,
    location: null,
    meetingLink: null,
    start: "",
    end: "",
    allDay: true,
    startTime: null,
    endTime: null,
    cancelled: true,
  };
}

function sessionListing(events: ProviderCalendarEvent[]) {
  const listEvents = vi.fn(async () => events);
  const session = { provider: "GOOGLE", listEvents } as unknown as CalendarSession;
  return { session, listEvents };
}

let nextId = 0;
function eventRow(
  externalId: string | null,
  over: { userId?: string; provider?: string; sourceKey?: string } = {},
) {
  nextId += 1;
  const row = {
    id: `row-${nextId}`,
    userId: "u1",
    provider: externalId === null ? "LOCAL" : "GOOGLE",
    sourceKey: "primary",
    externalId,
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

beforeEach(() => {
  vi.clearAllMocks();
  h.state.events = [];
  h.state.attention = [];
  nextId = 0;
});

describe("syncQuery", () => {
  it("asks the provider for cancelled events too, so a deletion can be seen", () => {
    expect(syncQuery(NOW, ZONE)).toEqual({
      timeMin: "2026-09-30T05:00:00.000Z",
      timeMax: "2026-10-30T05:00:00.000Z",
      maxResults: 100,
      timeZone: ZONE,
      includeCancelled: true,
    });
  });
});

describe("primary sync: events cancelled in Google", () => {
  it("deletes the cancelled event's row and resolves its attention items", async () => {
    const gone = eventRow("g-gone");
    const kept = eventRow("g-kept");
    const goneItem = attentionFor(gone.id);
    const keptItem = attentionFor(kept.id);
    const { session } = sessionListing([live("g-kept"), cancelled("g-gone")]);

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(eventIds()).toEqual([kept.id]);
    expect(attentionById(goneItem.id)).toMatchObject({ status: "RESOLVED", resolvedAt: NOW });
    expect(attentionById(keptItem.id)).toMatchObject({ status: "OPEN", resolvedAt: null });
  });

  it("does not upsert a cancelled event even when Google still sends its details", async () => {
    // The organizer's own calendar keeps summary/start/end on a cancelled event.
    const gone = eventRow("g-gone");
    const detailed = { ...live("g-gone"), cancelled: true } as ProviderCalendarEvent;
    const { session } = sessionListing([detailed]);

    const written = await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(h.prisma.calendarEvent.upsert).not.toHaveBeenCalled();
    expect(written).toBe(0);
    expect(eventIds()).not.toContain(gone.id);
  });

  it("keeps an event that is merely absent from the listing (the 100-event cap can truncate)", async () => {
    const absent = eventRow("g-absent");
    const absentItem = attentionFor(absent.id);
    const { session } = sessionListing([live("g-other")]);

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(eventIds()).toEqual([absent.id]);
    expect(attentionById(absentItem.id)).toMatchObject({ status: "OPEN" });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("keeps the upsert path as it was: live events are written, cancelled ones are not counted", async () => {
    const { session } = sessionListing([live("g-1"), cancelled("g-2"), live("g-3")]);

    const written = await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(written).toBe(2);
    expect(h.prisma.calendarEvent.upsert).toHaveBeenCalledTimes(2);
    const keys = h.prisma.calendarEvent.upsert.mock.calls.map(
      (c) => (c as unknown as [{ where: { userId_googleId: { googleId: string } } }])[0].where,
    );
    expect(keys.map((k) => k.userId_googleId.googleId)).toEqual(["g-1", "g-3"]);
  });

  it("never touches a LOCAL row, nor a row Google did not name", async () => {
    const local = eventRow(null);
    const localItem = attentionFor(local.id);
    const outside = eventRow("g-outside-window");
    // A cancelled event that arrives with no id at all must not match the NULL ids of LOCAL rows.
    const { session } = sessionListing([cancelled(""), cancelled("g-not-ours")]);

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(eventIds()).toEqual([local.id, outside.id]);
    expect(attentionById(localItem.id)).toMatchObject({ status: "OPEN" });
  });

  it("never touches another user's row that has the same Google event id", async () => {
    const mine = eventRow("shared-invite");
    const theirs = eventRow("shared-invite", { userId: "u2" });
    const theirsItem = attentionFor(theirs.id, { userId: "u2" });
    const { session } = sessionListing([cancelled("shared-invite")]);

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(eventIds()).toEqual([theirs.id]);
    expect(eventIds()).not.toContain(mine.id);
    expect(attentionById(theirsItem.id)).toMatchObject({ status: "OPEN" });
  });

  it("never touches another provider's row that happens to share the source and id", async () => {
    const other = eventRow("g-gone", { provider: "OUTLOOK" });
    const { session } = sessionListing([cancelled("g-gone")]);

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(eventIds()).toEqual([other.id]);
  });

  it("removes only the cancelled instance of a recurring event", async () => {
    const monday = eventRow("standup_20261005T000000Z");
    const tuesday = eventRow("standup_20261006T000000Z");
    const { session } = sessionListing([
      cancelled("standup_20261005T000000Z"),
      live("standup_20261006T000000Z"),
    ]);

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(eventIds()).toEqual([tuesday.id]);
    expect(eventIds()).not.toContain(monday.id);
  });

  it("leaves an attention item the user already dismissed as they left it", async () => {
    const gone = eventRow("g-gone");
    const dismissed = attentionFor(gone.id, { status: "DISMISSED" });
    const snoozed = attentionFor(gone.id, { status: "SNOOZED" });
    const { session } = sessionListing([cancelled("g-gone")]);

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(attentionById(dismissed.id)).toMatchObject({ status: "DISMISSED", resolvedAt: null });
    expect(attentionById(snoozed.id)).toMatchObject({ status: "RESOLVED", resolvedAt: NOW });
  });

  it("only resolves CALENDAR_EVENT items, even when another source reuses the id", async () => {
    const gone = eventRow("g-gone");
    const foreign = attentionFor(gone.id, { source: "TASK" });
    const { session } = sessionListing([cancelled("g-gone")]);

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(attentionById(foreign.id)).toMatchObject({ status: "OPEN" });
  });

  it("does all the removals of one sync in a single transaction", async () => {
    eventRow("g-1");
    eventRow("g-2");
    eventRow("g-3");
    const { session } = sessionListing([cancelled("g-1"), cancelled("g-2"), live("g-3")]);

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(h.tx.calendarEvent.deleteMany).toHaveBeenCalledTimes(1);
    expect(h.state.events.map((row) => row.externalId)).toEqual(["g-3"]);
  });

  it("is a no-op when the cancelled event has no local row (a repeat sync)", async () => {
    const { session } = sessionListing([cancelled("g-already-gone")]);

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(h.tx.attentionItem.updateMany).not.toHaveBeenCalled();
    expect(h.tx.calendarEvent.deleteMany).not.toHaveBeenCalled();
  });

  it("asks the session for cancelled events in the standard sync window", async () => {
    const { session, listEvents } = sessionListing([]);

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(listEvents).toHaveBeenCalledWith(syncQuery(NOW, ZONE));
    expect(listEvents).toHaveBeenCalledWith(expect.objectContaining({ includeCancelled: true }));
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
    const { session } = sessionListing([cancelled("g-shared")]);

    await syncLinkedCalendarWindow(session, "u1", "acct-work", ZONE, NOW);

    expect(eventIds()).toEqual([school.id, primary.id]);
    expect(attentionById(workItem.id)).toMatchObject({ status: "RESOLVED", resolvedAt: NOW });
    expect(attentionById(schoolItem.id)).toMatchObject({ status: "OPEN" });
    expect(attentionById(primaryItem.id)).toMatchObject({ status: "OPEN" });
  });

  it("a primary sync never removes a linked account's row", async () => {
    const linked = eventRow("g-shared", { sourceKey: "acct-work" });
    const primary = eventRow("g-shared", { sourceKey: "primary" });
    const { session } = sessionListing([cancelled("g-shared")]);

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(eventIds()).toEqual([linked.id]);
    expect(eventIds()).not.toContain(primary.id);
  });

  it("does not upsert a cancelled event and keeps an absent one", async () => {
    const absent = eventRow("g-absent", { sourceKey: "acct-work" });
    const { session } = sessionListing([cancelled("g-gone"), live("g-live")]);

    const written = await syncLinkedCalendarWindow(session, "u1", "acct-work", ZONE, NOW);

    expect(written).toBe(1);
    expect(h.prisma.calendarEvent.upsert).toHaveBeenCalledTimes(1);
    expect(eventIds()).toEqual([absent.id]);
  });
});
