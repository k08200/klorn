/**
 * "Waiting on" (2026-09-18): mail I sent that nobody answered. The rule is
 * the contract — latest-per-thread, minDays, replies only from others,
 * notes to self never count — plus the throttle and the fail-soft record.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  upserts: [] as unknown[],
  upsertFails: false,
  sentRows: [] as unknown[],
  replyRows: [] as unknown[],
  listCalls: 0,
  listResult: null as null | { items: unknown[]; nextPageToken: null },
  captured: [] as unknown[],
}));

vi.mock("../db.js", () => ({
  prisma: {
    sentMessage: {
      upsert: vi.fn(async (args: unknown) => {
        if (state.upsertFails) throw new Error("db down");
        state.upserts.push(args);
        return {};
      }),
      findMany: vi.fn(async () => state.sentRows),
    },
    emailMessage: { findMany: vi.fn(async () => state.replyRows) },
    user: { findUnique: vi.fn(async () => ({ email: "Me@Example.com" })) },
  },
}));

vi.mock("../sentry.js", () => ({
  captureError: vi.fn((err: unknown) => {
    state.captured.push(err);
  }),
}));

vi.mock("../mail/gmail-mailbox.js", () => ({
  listGmailMailbox: vi.fn(async () => {
    state.listCalls += 1;
    return state.listResult;
  }),
}));

import {
  computeWaitingOn,
  recordSentMessage,
  resetSentSyncThrottleForTests,
  syncSentMessages,
  waitingOnThreads,
} from "../mail/sent-messages.js";

const NOW = new Date("2026-09-18T09:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function sent(over: Partial<Parameters<typeof computeWaitingOn>[0][number]> = {}) {
  return {
    gmailId: "s1",
    threadId: "t1",
    to: "Sarah Kim <sarah@acme.com>",
    subject: "Contract",
    sentAt: daysAgo(3),
    inbox: "primary",
    ...over,
  };
}

describe("computeWaitingOn", () => {
  const opts = { now: NOW, minDays: 2, userEmail: "me@example.com" };

  it("a thread with my message unanswered for minDays is waiting, oldest first", () => {
    const out = computeWaitingOn(
      [sent(), sent({ gmailId: "s2", threadId: "t2", sentAt: daysAgo(10), subject: "Older" })],
      [],
      opts,
    );
    expect(out.map((i) => [i.threadId, i.daysWaiting])).toEqual([
      ["t2", 10],
      ["t1", 3],
    ]);
    expect(out[1]).toMatchObject({
      gmailId: "s1",
      to: "Sarah Kim <sarah@acme.com>",
      subject: "Contract",
      inbox: "primary",
      sentAt: daysAgo(3).toISOString(),
    });
  });

  it("a reply from someone else after my message clears it; a reply BEFORE it does not", () => {
    const answered = computeWaitingOn(
      [sent()],
      [{ threadId: "t1", receivedAt: daysAgo(1), from: "sarah@acme.com" }],
      opts,
    );
    expect(answered).toEqual([]);
    const earlier = computeWaitingOn(
      [sent()],
      [{ threadId: "t1", receivedAt: daysAgo(5), from: "sarah@acme.com" }],
      opts,
    );
    expect(earlier.map((i) => i.threadId)).toEqual(["t1"]);
  });

  it("only the LATEST thing I sent in a thread counts", () => {
    // I wrote on day 10, they answered on day 6, I wrote again on day 1 —
    // that last message is too recent to be waiting yet.
    const out = computeWaitingOn(
      [sent({ gmailId: "a", sentAt: daysAgo(10) }), sent({ gmailId: "b", sentAt: daysAgo(1) })],
      [{ threadId: "t1", receivedAt: daysAgo(6), from: "sarah@acme.com" }],
      opts,
    );
    expect(out).toEqual([]);
  });

  it("my own copy of a message (CC to self) is not an answer; a note to myself never waits", () => {
    const selfCopy = computeWaitingOn(
      [sent()],
      [{ threadId: "t1", receivedAt: daysAgo(1), from: "Me <ME@example.com>" }],
      opts,
    );
    expect(selfCopy.map((i) => i.threadId)).toEqual(["t1"]);
    expect(computeWaitingOn([sent({ to: "me@example.com" })], [], opts)).toEqual([]);
    expect(computeWaitingOn([sent({ to: "" })], [], opts)).toEqual([]);
    expect(computeWaitingOn([sent({ threadId: null })], [], opts)).toEqual([]);
  });

  it("minDays is a floor: a 1-day-old message is not waiting at minDays=2, is at 0", () => {
    const row = sent({ sentAt: daysAgo(1) });
    expect(computeWaitingOn([row], [], opts)).toEqual([]);
    expect(computeWaitingOn([row], [], { ...opts, minDays: 0 }).map((i) => i.daysWaiting)).toEqual([
      1,
    ]);
  });
});

describe("recordSentMessage / syncSentMessages", () => {
  beforeEach(() => {
    state.upserts.length = 0;
    state.captured.length = 0;
    state.upsertFails = false;
    state.listCalls = 0;
    state.listResult = {
      items: [
        {
          gmailId: "g1",
          threadId: "t1",
          to: "a@b.com",
          subject: "Hi",
          receivedAt: "2026-09-10T00:00:00.000Z",
          inbox: "primary",
        },
      ],
      nextPageToken: null,
    };
    resetSentSyncThrottleForTests();
  });

  it("record upserts by (user, gmailId) and never throws", async () => {
    await recordSentMessage("u1", sent());
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0]).toMatchObject({
      where: { userId_gmailId: { userId: "u1", gmailId: "s1" } },
    });
    state.upsertFails = true;
    await expect(recordSentMessage("u1", sent())).resolves.toBeUndefined();
    expect(state.captured).toHaveLength(1);
  });

  it("sync reads every account's Sent page once per 30 minutes and records each row", async () => {
    expect(await syncSentMessages("u1", NOW.getTime())).toBe(1);
    expect(state.upserts[0]).toMatchObject({
      create: { userId: "u1", gmailId: "g1", threadId: "t1", inbox: "primary" },
    });
    // Throttled: the next tick within the window does nothing.
    expect(await syncSentMessages("u1", NOW.getTime() + 60_000)).toBe(0);
    expect(state.listCalls).toBe(1);
    // After the window it runs again; a different user is independent.
    expect(await syncSentMessages("u1", NOW.getTime() + 31 * 60_000)).toBe(1);
    expect(await syncSentMessages("u2", NOW.getTime())).toBe(1);
    expect(state.listCalls).toBe(3);
  });

  it("not connected (null page) records nothing and is not an error", async () => {
    state.listResult = null;
    expect(await syncSentMessages("u1", NOW.getTime())).toBe(0);
    expect(state.upserts).toEqual([]);
    expect(state.captured).toEqual([]);
  });
});

describe("waitingOnThreads", () => {
  beforeEach(() => {
    state.sentRows = [sent(), sent({ gmailId: "s2", threadId: "t2", subject: "Answered" })];
    state.replyRows = [{ threadId: "t2", receivedAt: daysAgo(1), from: "x@y.com" }];
  });

  it("joins sent rows with the mirror's replies and applies the rule", async () => {
    const out = await waitingOnThreads("u1", { now: NOW, minDays: 2 });
    expect(out.map((i) => i.threadId)).toEqual(["t1"]);
  });

  it("no sent rows → no reply query, empty result", async () => {
    state.sentRows = [];
    expect(await waitingOnThreads("u1", { now: NOW })).toEqual([]);
  });
});
