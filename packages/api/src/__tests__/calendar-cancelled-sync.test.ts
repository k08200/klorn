/**
 * C2b: an event deleted or cancelled in Google is removed from Klorn on the next
 * sync, behind CALENDAR_CANCELLATION_SYNC_ENABLED (OFF by default). The sync's own
 * listing stays exactly as it was; cancellations come from a SEPARATE call
 * (session.listCancelledEvents), because cancelled events listed alongside live
 * ones would spend the 100-event cap and push live events out of the window.
 * A row that is merely absent from the listing is kept. Removal is the row's
 * whole identity (user, GOOGLE, source, id) plus its attention items, in one
 * transaction; a deleted series takes its instance rows with it; a failing
 * cancellation call never fails the sync.
 *
 * The prisma double below filters on the `where` it is given, so scoping mistakes
 * (user, provider, source) change what survives instead of hiding in a call log.
 * Its top-level calendarEvent has no findMany/deleteMany: only the transaction
 * client does, which is how the test holds the removal to one transaction.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelledScanRequest } from "./helpers/google-cancelled-scan.js";

const h = vi.hoisted(() => {
  type Rec = Record<string, unknown>;
  const state = { events: [] as Rec[], attention: [] as Rec[], created: 0 };
  const matches = (row: Rec, where: Rec): boolean =>
    Object.entries(where).every(([key, want]) => {
      if (key === "OR") return (want as Rec[]).some((clause) => matches(row, clause));
      if (want && typeof want === "object" && "in" in want) {
        return (want as { in: unknown[] }).in.includes(row[key]);
      }
      if (want && typeof want === "object" && "startsWith" in want) {
        const value = row[key];
        return (
          typeof value === "string" && value.startsWith((want as { startsWith: string }).startsWith)
        );
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
    calendarEvent: {
      // A real upsert: finds the row by the unique key the caller names, else creates it.
      upsert: vi.fn(async ({ where, create }: { where: Rec; create: Rec }) => {
        const key = (where.userId_googleId ?? where.userId_provider_sourceKey_externalId) as Rec;
        if (state.events.some((row) => matches(row, key))) return {};
        state.created += 1;
        state.events.push({ id: `created-${state.created}`, ...create });
        return {};
      }),
    },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { state, tx, prisma, captureError: vi.fn(), eventsList: vi.fn() };
});

vi.mock("../db.js", () => ({
  prisma: h.prisma,
  db: h.prisma,
  INTERACTIVE_TX_OPTIONS: { maxWait: 10_000, timeout: 15_000 },
}));
vi.mock("googleapis", () => ({
  google: { calendar: () => ({ events: { list: h.eventsList } }) },
}));
vi.mock("../mail/gmail.js", () => ({
  getAuthedClient: vi.fn(async () => ({})),
  buildLinkedCalendarClient: vi.fn(),
  isGoogleAuthError: vi.fn(() => false),
  markLinkedCalendarForReconnect: vi.fn(async () => {}),
}));
vi.mock("../sentry.js", () => ({ captureError: h.captureError }));

import {
  _resetCancelledScanStateForTests,
  CANCELLED_SCAN_STATE_CAP,
  reconcileCancelledEvents,
} from "../pim/calendar-cancellation.js";
import { googleSessionFromClient } from "../pim/calendar-providers/google.js";
import type {
  CalendarSession,
  CancelledEventsResult,
  ProviderCalendarEvent,
} from "../pim/calendar-providers/types.js";
import { syncLinkedCalendarWindow, syncPrimaryCalendarWindow } from "../pim/calendar-sync.js";

const FLAG = "CALENDAR_CANCELLATION_SYNC_ENABLED";
const NOW = new Date("2026-09-30T05:00:00.000Z");
const ZONE = "Asia/Seoul";
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const later = (ms: number) => new Date(NOW.getTime() + ms);
const iso = (ms: number) => new Date(ms).toISOString();

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

/** A cancelled item: a bare id is an event or series, `instanceOf` marks an instance of a series. */
type Cancelled = string | { id: string; instanceOf: string };
function scanOf(items: Cancelled[]): CancelledEventsResult {
  return {
    externalIds: items.map((item) => (typeof item === "string" ? item : item.id)),
    seriesIds: items.filter((item): item is string => typeof item === "string"),
    truncated: false,
    resumeUpdatedMin: null,
  };
}

interface SessionOptions {
  live?: ProviderCalendarEvent[];
  /** What the cancellation call answers, an error it throws, or null for a provider without one. */
  cancelled?: Cancelled[] | CancelledEventsResult | Error | null;
}

function makeSession(options: SessionOptions = {}) {
  const { live: liveEvents = [], cancelled = [] } = options;
  const listEvents = vi.fn(async (..._args: unknown[]) => liveEvents);
  const listCancelledEvents = vi.fn(async (..._args: unknown[]) => {
    if (cancelled instanceof Error) throw cancelled;
    if (Array.isArray(cancelled)) return scanOf(cancelled);
    return cancelled ?? scanOf([]);
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
  const sourceKey = over.sourceKey ?? "primary";
  const row = {
    id: `row-${nextId}`,
    userId: "u1",
    provider: externalId === null ? "LOCAL" : "GOOGLE",
    sourceKey,
    externalId,
    // A primary row carries its Google id in googleId too; a linked row never does.
    googleId: externalId !== null && sourceKey === "primary" ? externalId : null,
    title: "Secret board meeting",
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
const externalIds = () => h.state.events.map((row) => row.externalId);
const attentionById = (id: string) => h.state.attention.find((row) => row.id === id);
const scanArgs = (scan: { mock: { calls: unknown[][] } }, call = 0) =>
  scan.mock.calls[call]?.[0] as { updatedMin: string };

let warn: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  h.state.events = [];
  h.state.attention = [];
  h.state.created = 0;
  nextId = 0;
  _resetCancelledScanStateForTests();
  process.env[FLAG] = "true";
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env[FLAG];
});

describe("kill switch: CALENDAR_CANCELLATION_SYNC_ENABLED", () => {
  it.each([
    ["unset", undefined],
    ["false", "false"],
    ["0", "0"],
    ["a typo", "tru"],
    ["empty", ""],
  ])("%s: the sync makes no extra Google call and touches no row", async (_name, value) => {
    if (value === undefined) delete process.env[FLAG];
    else process.env[FLAG] = value;
    const gone = eventRow("g-gone");
    const { session, listEvents, listCancelledEvents } = makeSession({
      live: [live("g-1")],
      cancelled: ["g-gone"],
    });

    const written = await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(written).toBe(1);
    expect(listEvents).toHaveBeenCalledTimes(1);
    expect(listCancelledEvents).not.toHaveBeenCalled();
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(eventIds()).toContain(gone.id);
  });

  it.each([
    "true",
    "1",
    "yes",
    "on",
    " TRUE ",
  ])("%j turns the scan on, read at sync time", async (value) => {
    process.env[FLAG] = value;
    const { session, listCancelledEvents } = makeSession();

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(listCancelledEvents).toHaveBeenCalledTimes(1);
  });

  it("is read on every sync: flipping it takes effect without a restart", async () => {
    const { session, listCancelledEvents } = makeSession();

    delete process.env[FLAG];
    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);
    process.env[FLAG] = "true";
    await syncPrimaryCalendarWindow(session, "u1", ZONE, later(15 * MIN));
    delete process.env[FLAG];
    await syncPrimaryCalendarWindow(session, "u1", ZONE, later(30 * MIN));

    expect(listCancelledEvents).toHaveBeenCalledTimes(1);
  });
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

    expect(eventIds()).toContain(absent.id);
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
      cancelled: [{ id: "standup_20261005T000000Z", instanceOf: "standup" }],
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
    expect(externalIds()).toEqual(["g-3"]);
  });

  it("is a no-op when the cancelled event has no local row (a repeat sync)", async () => {
    const { session } = makeSession({ cancelled: ["g-already-gone"] });

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(h.tx.attentionItem.updateMany).not.toHaveBeenCalled();
    expect(h.tx.calendarEvent.deleteMany).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});

describe("a cancelled series takes its instance rows with it", () => {
  it("removes every instance row of a cancelled series, timed and all-day", async () => {
    const timed1 = eventRow("standup_20261005T000000Z");
    eventRow("standup_20261006T000000Z");
    eventRow("standup_20261007"); // an all-day instance
    const item = attentionFor(timed1.id);
    const { session } = makeSession({ cancelled: ["standup"] });

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(eventIds()).toEqual([]);
    expect(attentionById(item.id)).toMatchObject({ status: "RESOLVED", resolvedAt: NOW });
  });

  it("does not touch an unrelated id that merely shares the prefix", async () => {
    const separatorMissing = eventRow("standupx_20261005T000000Z");
    const noSeparator = eventRow("standup20261005T000000Z");
    const notAnInstance = eventRow("standup_extra");
    const otherSeries = eventRow("standup_extra_20261005T000000Z");
    const other = eventRow("lunch_20261005T000000Z");
    const { session } = makeSession({ cancelled: ["standup"] });

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(eventIds()).toEqual([
      separatorMissing.id,
      noSeparator.id,
      notAnInstance.id,
      otherSeries.id,
      other.id,
    ]);
  });

  it("reads the series id off the LAST separator, so an id that holds an underscore still matches", async () => {
    const instance = eventRow("ab_cd_20261005T000000Z");
    const sibling = eventRow("ab_20261005T000000Z");
    const { session } = makeSession({ cancelled: ["ab_cd"] });

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(eventIds()).toEqual([sibling.id]);
    expect(eventIds()).not.toContain(instance.id);
  });

  it("a cancelled instance (it has a parent series) removes only itself, never its siblings", async () => {
    const monday = eventRow("standup_20261005T000000Z");
    const tuesday = eventRow("standup_20261006T000000Z");
    const { session } = makeSession({
      cancelled: [{ id: "standup_20261005T000000Z", instanceOf: "standup" }],
    });

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(eventIds()).toEqual([tuesday.id]);
    expect(eventIds()).not.toContain(monday.id);
  });

  it("stays inside the user, the provider and the source", async () => {
    const mine = eventRow("standup_20261005T000000Z");
    const theirs = eventRow("standup_20261005T000000Z", { userId: "u2" });
    const outlook = eventRow("standup_20261005T000000Z", { provider: "OUTLOOK" });
    const linked = eventRow("standup_20261005T000000Z", { sourceKey: "acct-work" });
    const { session } = makeSession({ cancelled: ["standup"] });

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(eventIds()).toEqual([theirs.id, outlook.id, linked.id]);
    expect(eventIds()).not.toContain(mine.id);
  });

  it("in a linked account removes that account's instance rows, never the primary's", async () => {
    const work = eventRow("standup_20261005T000000Z", { sourceKey: "acct-work" });
    const primary = eventRow("standup_20261005T000000Z");
    const { session } = makeSession({ cancelled: ["standup"] });

    await syncLinkedCalendarWindow(session, "u1", "acct-work", ZONE, NOW);

    expect(eventIds()).toEqual([primary.id]);
    expect(eventIds()).not.toContain(work.id);
  });

  it("reaches a primary instance row written by the previous release (no externalId yet)", async () => {
    eventRow(null, { provider: "GOOGLE", googleId: "standup_20261005T000000Z" });
    const { session } = makeSession({ cancelled: ["standup"] });

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(eventIds()).toEqual([]);
  });

  it("an event that is not a series, cancelled, removes only itself", async () => {
    const lunch = eventRow("lunch");
    const other = eventRow("lunchtime_20261005T000000Z");
    const { session } = makeSession({ cancelled: ["lunch"] });

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(eventIds()).toEqual([other.id]);
    expect(eventIds()).not.toContain(lunch.id);
  });
});

describe("a restored event", () => {
  it("comes back on the next sync as a new row, is not removed again, and its old attention item stays resolved", async () => {
    const gone = eventRow("g-1");
    const goneItem = attentionFor(gone.id);

    await syncPrimaryCalendarWindow(makeSession({ cancelled: ["g-1"] }).session, "u1", ZONE, NOW);
    expect(eventIds()).toEqual([]);

    const restored = makeSession({ live: [live("g-1")], cancelled: [] });
    await syncPrimaryCalendarWindow(restored.session, "u1", ZONE, later(15 * MIN));
    await syncPrimaryCalendarWindow(restored.session, "u1", ZONE, later(30 * MIN));

    expect(externalIds()).toEqual(["g-1"]);
    expect(eventIds()).not.toContain(gone.id);
    expect(attentionById(goneItem.id)).toMatchObject({ status: "RESOLVED" });
  });

  it("is removed when the scan names it although the same sync just wrote it (deleted between the two calls)", async () => {
    const { session } = makeSession({ live: [live("g-1")], cancelled: ["g-1"] });

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(h.prisma.calendarEvent.upsert).toHaveBeenCalledTimes(1);
    expect(externalIds()).toEqual([]);
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
    expect(eventIds()).toContain(absent.id);
  });
});

describe("the cancellation call's start", () => {
  it("is the last 7 days on a first scan, with no time window of its own", async () => {
    const { session, listCancelledEvents } = makeSession();

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(listCancelledEvents).toHaveBeenCalledTimes(1);
    expect(listCancelledEvents.mock.calls[0]?.[0]).toStrictEqual({
      updatedMin: iso(NOW.getTime() - 7 * DAY),
    });
  });

  it("after a complete scan, reaches back only to that scan minus a 30 minute margin", async () => {
    const { session, listCancelledEvents } = makeSession();

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);
    await syncPrimaryCalendarWindow(session, "u1", ZONE, later(15 * MIN));

    expect(scanArgs(listCancelledEvents, 1).updatedMin).toBe(iso(NOW.getTime() - 30 * MIN));
  });

  it("never reaches back further than 7 days, however long ago the last scan was", async () => {
    const { session, listCancelledEvents } = makeSession();

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);
    const afterGap = later(10 * DAY);
    await syncPrimaryCalendarWindow(session, "u1", ZONE, afterGap);

    expect(scanArgs(listCancelledEvents, 1).updatedMin).toBe(iso(afterGap.getTime() - 7 * DAY));
  });

  it("does not move when the scan fails", async () => {
    const ok = makeSession();
    const broken = makeSession({ cancelled: new Error("quota") });

    await syncPrimaryCalendarWindow(ok.session, "u1", ZONE, NOW);
    await syncPrimaryCalendarWindow(broken.session, "u1", ZONE, later(15 * MIN));
    await syncPrimaryCalendarWindow(ok.session, "u1", ZONE, later(30 * MIN));

    expect(scanArgs(ok.listCancelledEvents, 1).updatedMin).toBe(iso(NOW.getTime() - 30 * MIN));
  });

  it("keeps each account's progress apart", async () => {
    const primary = makeSession();
    const work = makeSession();

    await syncPrimaryCalendarWindow(primary.session, "u1", ZONE, NOW);
    await syncLinkedCalendarWindow(work.session, "u1", "acct-work", ZONE, later(15 * MIN));

    expect(scanArgs(work.listCancelledEvents).updatedMin).toBe(
      iso(later(15 * MIN).getTime() - 7 * DAY),
    );
  });
});

describe("a truncated scan resumes where it stopped", () => {
  const truncated = (resumeUpdatedMin: string | null, ids: Cancelled[] = ["a"]) => ({
    ...scanOf(ids),
    truncated: true,
    resumeUpdatedMin,
  });

  it("starts the next scan exactly at the last event it read (no margin), warning once", async () => {
    const stopped = iso(NOW.getTime() - 40 * MIN);
    const cut = makeSession({ cancelled: truncated(stopped) });
    const next = makeSession();

    await syncPrimaryCalendarWindow(cut.session, "u1", ZONE, NOW);
    await syncPrimaryCalendarWindow(cut.session, "u1", ZONE, later(MIN));

    expect(scanArgs(cut.listCancelledEvents, 1).updatedMin).toBe(stopped);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("truncated");
    expect(h.captureError).not.toHaveBeenCalled();
    await syncPrimaryCalendarWindow(next.session, "u1", ZONE, later(2 * MIN));
    expect(scanArgs(next.listCancelledEvents).updatedMin).toBe(stopped);
  });

  it("never starts before the 7 day lookback", async () => {
    const cut = makeSession({ cancelled: truncated(iso(NOW.getTime() - 20 * DAY)) });
    const next = makeSession();

    await syncPrimaryCalendarWindow(cut.session, "u1", ZONE, NOW);
    await syncPrimaryCalendarWindow(next.session, "u1", ZONE, later(MIN));

    expect(scanArgs(next.listCancelledEvents).updatedMin).toBe(iso(later(MIN).getTime() - 7 * DAY));
  });

  it("stays put when it has nothing to resume from, or made no progress", async () => {
    const noResume = makeSession({ cancelled: truncated(null) });
    const noProgress = makeSession({ cancelled: truncated(iso(NOW.getTime() - 7 * DAY)) });
    const next = makeSession();

    await syncPrimaryCalendarWindow(noResume.session, "u1", ZONE, NOW);
    await syncPrimaryCalendarWindow(noProgress.session, "u2", ZONE, NOW);
    await syncPrimaryCalendarWindow(next.session, "u1", ZONE, later(MIN));
    await syncPrimaryCalendarWindow(next.session, "u2", ZONE, later(MIN));

    const floor = iso(later(MIN).getTime() - 7 * DAY);
    expect(scanArgs(next.listCancelledEvents, 0).updatedMin).toBe(floor);
    expect(scanArgs(next.listCancelledEvents, 1).updatedMin).toBe(floor);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("still removes what the truncated scan did find", async () => {
    const gone = eventRow("g-gone");
    const cut = makeSession({ cancelled: truncated(iso(NOW.getTime() - MIN), ["g-gone"]) });

    await syncPrimaryCalendarWindow(cut.session, "u1", ZONE, NOW);

    expect(eventIds()).not.toContain(gone.id);
  });

  it("converges over consecutive syncs and catches a tombstone that sits past page 4", async () => {
    // 2600 events changed in the last hour, one per second, oldest first; the live
    // ones are noise. Three tombstones: inside the first 1000, past page 4 (index
    // 1500), and in the last stretch.
    const T0 = NOW.getTime() - 60 * MIN;
    const tombstones = new Set([10, 1500, 2300]);
    const items = Array.from({ length: 2600 }, (_, i) => ({
      id: `ev-${i}`,
      status: tombstones.has(i) ? "cancelled" : "confirmed",
      updated: iso(T0 + i * 1000),
    }));
    h.eventsList.mockImplementation(
      async (params: {
        showDeleted?: boolean;
        updatedMin?: string;
        pageToken?: string;
        maxResults?: number;
      }) => {
        if (!params.showDeleted) return { data: { items: [] } };
        const since = Date.parse(params.updatedMin ?? "");
        const pool = items.filter((item) => Date.parse(item.updated) >= since);
        const start = params.pageToken ? Number(params.pageToken) : 0;
        const size = params.maxResults ?? 250;
        const next = start + size < pool.length ? String(start + size) : undefined;
        return {
          data: {
            items: pool.slice(start, start + size),
            ...(next ? { nextPageToken: next } : {}),
          },
        };
      },
    );
    for (const i of tombstones) eventRow(`ev-${i}`);
    const session = googleSessionFromClient({} as never);

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);
    expect(externalIds()).toEqual(["ev-1500", "ev-2300"]);

    await syncPrimaryCalendarWindow(session, "u1", ZONE, later(15 * MIN));
    expect(externalIds()).toEqual(["ev-2300"]);

    await syncPrimaryCalendarWindow(session, "u1", ZONE, later(30 * MIN));
    expect(externalIds()).toEqual([]);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("truncated"))).toHaveLength(1);

    // The third scan was complete: the next one is back to the narrow steady-state start.
    await syncPrimaryCalendarWindow(session, "u1", ZONE, later(45 * MIN));
    const scans = h.eventsList.mock.calls.filter(
      (c) => (c[0] as { showDeleted?: boolean }).showDeleted,
    );
    expect((scans.at(-1)?.[0] as { updatedMin: string }).updatedMin).toBe(
      iso(later(30 * MIN).getTime() - 30 * MIN),
    );
  });
});

describe("what a scan logs", () => {
  it("one line per account and sync when rows were removed: account, rows, resolved items, no titles", async () => {
    const a = eventRow("g-1");
    eventRow("g-2");
    attentionFor(a.id);
    const { session } = makeSession({ cancelled: ["g-1", "g-2"] });

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toBe(
      "[CALENDAR] cancelled events removed u1:primary rows=2 attentionResolved=1",
    );
    expect(JSON.stringify([...log.mock.calls, ...warn.mock.calls])).not.toContain("Secret board");
  });

  it("names the linked account by source key", async () => {
    eventRow("g-1", { sourceKey: "acct-work" });
    const { session } = makeSession({ cancelled: ["g-1"] });

    await syncLinkedCalendarWindow(session, "u1", "acct-work", ZONE, NOW);

    expect(String(log.mock.calls[0]?.[0])).toContain("u1:acct-work rows=1 attentionResolved=0");
  });

  it("says nothing when nothing was removed", async () => {
    const { session } = makeSession({ cancelled: ["g-unknown"] });

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(log).not.toHaveBeenCalled();
  });
});

describe("a failing cancellation step never fails the sync", () => {
  it("still upserts and answers when the cancellation call throws, logging once", async () => {
    const { session } = makeSession({ live: [live("g-1")], cancelled: new Error("quota") });

    const written = await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);
    const writtenAgain = await syncPrimaryCalendarWindow(session, "u1", ZONE, later(15 * MIN));

    expect([written, writtenAgain]).toEqual([1, 1]);
    expect(h.prisma.calendarEvent.upsert).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("quota");
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
  });

  it("still answers when the call times out", async () => {
    const timeout = Object.assign(new Error("timeout of 10000ms exceeded"), { code: "ETIMEDOUT" });
    const { session } = makeSession({ live: [live("g-1")], cancelled: timeout });

    const written = await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(written).toBe(1);
    expect(h.captureError).not.toHaveBeenCalled();
  });

  it("syncs a provider that has no cancellation call exactly as before", async () => {
    const { session } = makeSession({ live: [live("g-1")], cancelled: null });

    const written = await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(written).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("a non-transient failure reaches Sentry once per process", () => {
  const status = (code: number) =>
    Object.assign(new Error(`google said ${code}`), { response: { status: code } });

  it.each([400, 401, 403, 404])("a %i is reported", async (code) => {
    const { session } = makeSession({ cancelled: status(code) });

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(h.captureError).toHaveBeenCalledTimes(1);
    expect(h.captureError.mock.calls[0]?.[1]).toMatchObject({
      tags: { scope: "calendar.cancelled_scan" },
      extra: { status: code },
    });
  });

  it.each([429, 500, 503])("a %i is transient: logged, not reported", async (code) => {
    const { session } = makeSession({ cancelled: status(code) });

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(h.captureError).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a plain error is not reported", async () => {
    const { session } = makeSession({ cancelled: new Error("boom") });

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    expect(h.captureError).not.toHaveBeenCalled();
  });

  it("is once per process, across accounts and across syncs", async () => {
    const { session } = makeSession({ cancelled: status(403) });

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);
    await syncPrimaryCalendarWindow(session, "u1", ZONE, later(15 * MIN));
    await syncPrimaryCalendarWindow(session, "u2", ZONE, later(15 * MIN));
    await syncLinkedCalendarWindow(session, "u1", "acct-work", ZONE, later(15 * MIN));

    expect(h.captureError).toHaveBeenCalledTimes(1);
  });
});

describe("the in-memory scan state is bounded", () => {
  it("forgets the least recently scanned account once the cap is passed", async () => {
    const { session, listCancelledEvents } = makeSession();

    for (let i = 0; i <= CANCELLED_SCAN_STATE_CAP; i += 1) {
      await reconcileCancelledEvents(session, `user-${i}`, null, NOW);
    }
    await reconcileCancelledEvents(session, "user-0", null, later(MIN));
    await reconcileCancelledEvents(session, `user-${CANCELLED_SCAN_STATE_CAP}`, null, later(MIN));

    const calls = listCancelledEvents.mock.calls;
    const forgotten = calls.at(-2)?.[0] as { updatedMin: string };
    const remembered = calls.at(-1)?.[0] as { updatedMin: string };
    expect(forgotten.updatedMin).toBe(iso(later(MIN).getTime() - 7 * DAY));
    expect(remembered.updatedMin).toBe(iso(NOW.getTime() - 30 * MIN));
  });
});

describe("the scan request the real Google session sends", () => {
  it("is the shared request shape, starting at the computed updatedMin", async () => {
    h.eventsList.mockResolvedValue({ data: { items: [] } });
    const session = googleSessionFromClient({} as never);

    await syncPrimaryCalendarWindow(session, "u1", ZONE, NOW);

    const scan = h.eventsList.mock.calls.find(
      (c) => (c[0] as { showDeleted?: boolean }).showDeleted,
    );
    expect(scan?.[0]).toStrictEqual(cancelledScanRequest(iso(NOW.getTime() - 7 * DAY)));
  });
});
