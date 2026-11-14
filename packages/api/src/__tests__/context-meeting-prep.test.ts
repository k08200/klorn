/**
 * Meeting prep reader (Context Engine slice 1): the flag, the live attendee
 * listing (attendees are never stored — read from the calendar provider in
 * memory, matched to the user's CalendarEvent rows by source and event id),
 * the queries (every one scoped to the caller), and the cost rules: no
 * provider call without a meeting, no mail query without an external
 * attendee, and never a model call.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date("2099-03-02T00:00:00Z");

const m = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
  mails: [] as Array<Record<string, unknown>>,
  commitments: [] as Array<Record<string, unknown>>,
  labels: [] as Array<Record<string, unknown>>,
  sent: [] as Array<Record<string, unknown>>,
  attention: [] as Array<Record<string, unknown>>,
  linkedAccounts: [{ id: "lk-1", provider: "GOOGLE", needsReconnect: false }] as Array<
    Record<string, unknown>
  >,
  where: {} as Record<string, Array<Record<string, unknown>>>,
  own: new Map<string, string[]>(),
  listings: new Map<string, Array<Record<string, unknown>>>(),
  primaryCalls: [] as string[],
  linkedCalls: [] as string[],
  listCalls: [] as Array<{ userId: string; source: string }>,
  failListing: false,
}));

vi.mock("../db.js", () => {
  const rows: Record<string, () => Array<Record<string, unknown>>> = {
    calendarEvent: () => m.events,
    emailMessage: () => m.mails,
    commitment: () => m.commitments,
    decisionLabel: () => m.labels,
    sentMessage: () => m.sent,
    attentionItem: () => m.attention,
  };
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) =>
          vi.fn(async (args: Record<string, unknown> = {}) => {
            if (method === "findMany") {
              m.where[name] = [...(m.where[name] ?? []), args.where as Record<string, unknown>];
              const userId = (args.where as { userId?: string } | undefined)?.userId;
              return (rows[name]?.() ?? []).filter((r) => r.userId === userId);
            }
            if (method === "count") return 0;
            return null;
          }),
      },
    );
  const prisma = new Proxy({}, { get: (_t, name: string) => model(name) });
  return { prisma, db: prisma };
});

vi.mock("../pim/coattendance/coattendance-store.js", () => ({
  loadOwnAddresses: vi.fn(async (userId: string) => new Set(m.own.get(userId) ?? [])),
}));

function session(userId: string, source: string) {
  return {
    provider: "GOOGLE",
    listMeetingAttendees: vi.fn(async () => {
      m.listCalls.push({ userId, source });
      if (m.failListing) throw new Error("boom");
      return {
        meetings: m.listings.get(`${userId}|${source}`) ?? [],
        truncated: false,
        lastStart: null,
      };
    }),
  };
}

vi.mock("../pim/calendar-providers/dispatch.js", () => ({
  connectPrimaryCalendar: vi.fn(async (userId: string) => {
    m.primaryCalls.push(userId);
    return session(userId, "primary");
  }),
  listLinkedCalendarAccounts: vi.fn(async (userId: string) => {
    m.linkedCalls.push(userId);
    return m.linkedAccounts;
  }),
  calendarActionsForProvider: vi.fn(() => ({
    connect: vi.fn(
      async ({ userId, linkedAccountId }: { userId: string; linkedAccountId: string }) => {
        if (linkedAccountId === "lk-broken") throw new Error("token decrypt failed");
        return session(userId, linkedAccountId);
      },
    ),
  })),
}));

vi.mock("../llm/openai.js", () => ({ MODEL: "test-model", createCompletion: vi.fn() }));

import { buildMeetingPrep } from "../context/meeting-prep.js";
import { __resetMeetingPrepAttendeeCacheForTests } from "../context/meeting-prep-attendees.js";
import { meetingPrepForUser } from "../context/meeting-prep-surface.js";
import { createCompletion } from "../llm/openai.js";

function event(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `ev-${userId}`,
    userId,
    title: "Acme quote review",
    description: null,
    location: null,
    startTime: new Date(NOW.getTime() + 10 * HOUR),
    endTime: new Date(NOW.getTime() + 11 * HOUR),
    allDay: false,
    provider: "GOOGLE",
    externalId: `g-${userId}`,
    sourceAccountId: null,
    ...overrides,
  };
}

function providerMeeting(eventId: string, attendees: string[]) {
  return {
    identity: `id:${eventId}`,
    eventId,
    cancelled: false,
    allDay: false,
    startTime: new Date(NOW.getTime() + 10 * HOUR),
    endTime: new Date(NOW.getTime() + 11 * HOUR),
    attendeesOmitted: false,
    organizedBySelf: true,
    attendees: attendees.map((email) => ({
      email,
      self: false,
      organizer: false,
      resource: false,
      responseStatus: "accepted",
    })),
  };
}

function mail(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `m-${userId}`,
    userId,
    threadId: `t-${userId}`,
    from: "Alice <alice@acme.com>",
    fromAddress: "alice@acme.com",
    subject: "Quote request",
    receivedAt: new Date(NOW.getTime() - DAY),
    needsReply: true,
    repliedAt: null,
    listUnsubscribeUrl: null,
    listUnsubscribeMailto: null,
    ...overrides,
  };
}

function commitment(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `c-${userId}`,
    userId,
    title: "Send the quote",
    owner: "USER",
    counterpartyEmail: "alice@acme.com",
    counterpartyName: "Alice",
    dueAt: new Date(NOW.getTime() + 3 * DAY),
    createdAt: new Date(NOW.getTime() - 2 * DAY),
    confidence: 0.5,
    confirmedAt: new Date(NOW.getTime() - DAY),
    threadId: `t-${userId}`,
    ...overrides,
  };
}

/** One user with a meeting tomorrow morning with alice@acme.com, mail and a commitment. */
function seedUser(userId: string, ownAddress: string) {
  m.own.set(userId, [ownAddress]);
  m.events.push(event(userId));
  m.listings.set(`${userId}|primary`, [providerMeeting(`g-${userId}`, ["alice@acme.com"])]);
  m.mails.push(mail(userId));
  m.commitments.push(commitment(userId));
}

beforeEach(() => {
  m.events = [];
  m.mails = [];
  m.commitments = [];
  m.labels = [];
  m.sent = [];
  m.attention = [];
  m.linkedAccounts = [{ id: "lk-1", provider: "GOOGLE", needsReconnect: false }];
  m.where = {};
  m.own = new Map();
  m.listings = new Map();
  m.primaryCalls = [];
  m.linkedCalls = [];
  m.listCalls = [];
  m.failListing = false;
  vi.mocked(createCompletion).mockClear();
  __resetMeetingPrepAttendeeCacheForTests();
  delete process.env.CONTEXT_MEETING_PREP_ENABLED;
  delete process.env.ROLLOUT_COHORT_USER_IDS;
});

describe("flag", () => {
  it("off (default): no block, no read at all", async () => {
    seedUser("u1", "me@mycorp.com");
    expect(await meetingPrepForUser("u1", NOW)).toBeNull();
    expect(m.where).toEqual({});
    expect(m.primaryCalls).toEqual([]);
  });

  it("cohort: only users in ROLLOUT_COHORT_USER_IDS get the block", async () => {
    process.env.CONTEXT_MEETING_PREP_ENABLED = "cohort";
    process.env.ROLLOUT_COHORT_USER_IDS = "u1";
    seedUser("u1", "me@mycorp.com");
    seedUser("u2", "me@theirco.com");
    expect((await meetingPrepForUser("u1", NOW))?.meetings).toHaveLength(1);
    expect(await meetingPrepForUser("u2", NOW)).toBeNull();
    expect(m.primaryCalls).toEqual(["u1"]);
  });

  it("on: a provider failure degrades to no block, never a throw", async () => {
    process.env.CONTEXT_MEETING_PREP_ENABLED = "true";
    seedUser("u1", "me@mycorp.com");
    m.failListing = true;
    expect(await meetingPrepForUser("u1", NOW)).toBeNull();
  });
});

describe("buildMeetingPrep", () => {
  it("links the meeting to the attendee's mail and commitment, each item sourced", async () => {
    seedUser("u1", "me@mycorp.com");
    const block = await buildMeetingPrep("u1", NOW);
    expect(block?.meetings).toHaveLength(1);
    const prep = block?.meetings[0];
    expect(prep).toMatchObject({
      eventId: "ev-u1",
      title: "Acme quote review",
      attendees: ["alice@acme.com"],
    });
    expect(prep?.items.map((i) => i.source)).toEqual([
      { kind: "commitment", commitmentId: "c-u1" },
      { kind: "email", emailId: "m-u1" },
    ]);
    expect(prep?.items[1]).toMatchObject({ kind: "unanswered" });
  });

  it("a thread the user already answered is a recent thread, not unanswered", async () => {
    seedUser("u1", "me@mycorp.com");
    m.sent.push({ userId: "u1", threadId: "t-u1", sentAt: new Date(NOW.getTime() - HOUR) });
    m.commitments = [];
    const block = await buildMeetingPrep("u1", NOW);
    expect(block?.meetings[0]?.items[0]).toMatchObject({ kind: "thread" });
  });

  it("no meeting: no provider call, no mail query, no model call", async () => {
    m.own.set("u1", ["me@mycorp.com"]);
    m.mails.push(mail("u1"));
    expect(await buildMeetingPrep("u1", NOW)).toBeNull();
    expect(m.primaryCalls).toEqual([]);
    expect(m.where.emailMessage).toBeUndefined();
    expect(createCompletion).not.toHaveBeenCalled();
  });

  it("a meeting with only colleagues: no mail query, no model call", async () => {
    m.own.set("u1", ["me@mycorp.com"]);
    m.events.push(event("u1"));
    m.listings.set("u1|primary", [providerMeeting("g-u1", ["colleague@mycorp.com"])]);
    expect(await buildMeetingPrep("u1", NOW)).toBeNull();
    expect(m.where.emailMessage).toBeUndefined();
    expect(m.where.commitment).toBeUndefined();
    expect(createCompletion).not.toHaveBeenCalled();
  });

  it("never calls a model, even with a full block", async () => {
    seedUser("u1", "me@mycorp.com");
    await buildMeetingPrep("u1", NOW);
    expect(createCompletion).not.toHaveBeenCalled();
  });

  it("matches a linked calendar's row through that calendar's own listing", async () => {
    m.own.set("u1", ["me@mycorp.com"]);
    m.events.push(event("u1", { sourceAccountId: "lk-1", externalId: "g-linked" }));
    // The same event id in the primary listing must not be used for a linked row.
    m.listings.set("u1|primary", [providerMeeting("g-linked", ["mallory@evil.com"])]);
    m.listings.set("u1|lk-1", [providerMeeting("g-linked", ["alice@acme.com"])]);
    m.mails.push(mail("u1"));
    const block = await buildMeetingPrep("u1", NOW);
    expect(m.linkedCalls).toEqual(["u1"]);
    expect(m.primaryCalls).toEqual([]);
    expect(block?.meetings[0]?.attendees).toEqual(["alice@acme.com"]);
  });
});

describe("no cross-user leakage", () => {
  it("every query is scoped to the caller, and another user's rows never appear", async () => {
    seedUser("u1", "me@mycorp.com");
    seedUser("u2", "me@theirco.com");
    const block = await buildMeetingPrep("u1", NOW);
    const ids = block?.meetings.flatMap((p) =>
      p.items.map((i) => (i.source.kind === "email" ? i.source.emailId : i.source.commitmentId)),
    );
    expect(ids).toEqual(["c-u1", "m-u1"]);
    for (const [model, wheres] of Object.entries(m.where)) {
      for (const where of wheres)
        expect({ model, userId: where.userId }).toEqual({ model, userId: "u1" });
    }
  });

  it("the attendee cache is per user: one user's listing never serves another", async () => {
    seedUser("u1", "me@mycorp.com");
    seedUser("u2", "me@theirco.com");
    m.listings.set("u2|primary", [providerMeeting("g-u2", ["bob@globex.com"])]);
    m.mails.push(
      mail("u2", {
        id: "m-u2-globex",
        threadId: "t-g",
        from: "bob@globex.com",
        fromAddress: "bob@globex.com",
      }),
    );
    await buildMeetingPrep("u1", NOW);
    const second = await buildMeetingPrep("u2", NOW);
    expect(second?.meetings[0]?.attendees).toEqual(["bob@globex.com"]);
    expect(m.listCalls.map((c) => c.userId)).toEqual(["u1", "u2"]);
  });

  it("the same user within the cache window lists the calendar once", async () => {
    seedUser("u1", "me@mycorp.com");
    await buildMeetingPrep("u1", NOW);
    await buildMeetingPrep("u1", new Date(NOW.getTime() + 60_000));
    expect(m.listCalls).toHaveLength(1);
  });
});

describe("linking details", () => {
  it("links the user's own promise (no counterparty address) through the attendee's thread", async () => {
    seedUser("u1", "me@mycorp.com");
    m.commitments = [commitment("u1", { counterpartyEmail: null, threadId: "t-u1" })];
    const block = await buildMeetingPrep("u1", NOW);
    expect(block?.meetings[0]?.items[0]).toMatchObject({
      kind: "commitment",
      owner: "USER",
      source: { kind: "commitment", commitmentId: "c-u1" },
    });
    const where = m.where.commitment?.[0] as { OR: Array<Record<string, unknown>> };
    expect(where.OR).toContainEqual({ threadId: { in: ["t-u1"] } });
  });

  it("mail whose attention item is closed is not unanswered", async () => {
    seedUser("u1", "me@mycorp.com");
    m.commitments = [];
    m.attention.push({ userId: "u1", sourceId: "m-u1", status: "DONE" });
    const block = await buildMeetingPrep("u1", NOW);
    expect(block?.meetings[0]?.items[0]).toMatchObject({ kind: "thread" });
  });

  it("keeps mailings out of the mail scan itself", async () => {
    seedUser("u1", "me@mycorp.com");
    await buildMeetingPrep("u1", NOW);
    expect(m.where.emailMessage?.[0]).toMatchObject({
      listUnsubscribeUrl: null,
      listUnsubscribeMailto: null,
    });
  });
});

describe("attendee listing cache", () => {
  const MINUTE = 60_000;

  it("relists after the cache window", async () => {
    seedUser("u1", "me@mycorp.com");
    await buildMeetingPrep("u1", NOW);
    await buildMeetingPrep("u1", new Date(NOW.getTime() + 11 * MINUTE));
    expect(m.listCalls).toHaveLength(2);
  });

  it("holds a failed listing briefly, then retries", async () => {
    seedUser("u1", "me@mycorp.com");
    m.failListing = true;
    await buildMeetingPrep("u1", NOW);
    await buildMeetingPrep("u1", new Date(NOW.getTime() + MINUTE));
    expect(m.listCalls).toHaveLength(1);
    m.failListing = false;
    const later = await buildMeetingPrep("u1", new Date(NOW.getTime() + 3 * MINUTE));
    expect(m.listCalls).toHaveLength(2);
    expect(later?.meetings).toHaveLength(1);
  });

  it("concurrent builds share one listing", async () => {
    seedUser("u1", "me@mycorp.com");
    await Promise.all([buildMeetingPrep("u1", NOW), buildMeetingPrep("u1", NOW)]);
    expect(m.listCalls).toHaveLength(1);
  });

  it("a linked calendar awaiting re-link does not force a relisting on every build", async () => {
    seedUser("u1", "me@mycorp.com");
    m.linkedAccounts = [{ id: "lk-1", provider: "GOOGLE", needsReconnect: true }];
    m.events.push(event("u1", { id: "ev-linked", sourceAccountId: "lk-1", externalId: "g-l" }));
    await buildMeetingPrep("u1", NOW);
    await buildMeetingPrep("u1", new Date(NOW.getTime() + MINUTE));
    expect(m.listCalls).toEqual([{ userId: "u1", source: "primary" }]);
  });

  it("a linked account that fails to connect does not take the primary calendar down with it", async () => {
    seedUser("u1", "me@mycorp.com");
    m.linkedAccounts = [{ id: "lk-broken", provider: "GOOGLE", needsReconnect: false }];
    m.events.push(
      event("u1", { id: "ev-broken", sourceAccountId: "lk-broken", externalId: "g-b" }),
    );
    const block = await buildMeetingPrep("u1", NOW);
    expect(block?.meetings.map((p) => p.eventId)).toEqual(["ev-u1"]);
  });
});
