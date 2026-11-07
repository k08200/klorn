/**
 * "Waiting on" (2026-09-18): mail I sent that nobody answered. The rule is
 * the contract — latest-per-thread, minDays, replies only from others,
 * notes to self never count — plus the throttle and the fail-soft record.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  upserts: [] as unknown[],
  upsertFails: false,
  upsertError: null as unknown,
  upsertConflictsLeft: 0,
  sentRows: [] as unknown[],
  replyRows: [] as unknown[],
  listCalls: 0,
  listResult: null as null | { items: unknown[]; nextPageToken: null },
  captured: [] as unknown[],
  labels: new Map<string, string>(),
  classifyCalls: [] as unknown[][],
  classifyFails: false,
}));

vi.mock("../db.js", () => ({
  prisma: {
    sentMessage: {
      upsert: vi.fn(async (args: unknown) => {
        if (state.upsertError) throw state.upsertError;
        if (state.upsertFails) throw new Error("db down");
        if (state.upsertConflictsLeft > 0) {
          state.upsertConflictsLeft -= 1;
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
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

vi.mock("../mail/sent-origin-classifier.js", () => ({
  classifySentRows: vi.fn(async (_userId: string, rows: unknown[]) => {
    state.classifyCalls.push(rows);
    if (state.classifyFails) {
      throw Object.assign(new Error("db down near unsub@list.com"), {
        name: "PrismaClientKnownRequestError",
        code: "P1001",
      });
    }
    return state.labels;
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
import { captureError } from "../sentry.js";

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

  it("an unsubscribe request is never waiting on a reply", () => {
    const out = computeWaitingOn(
      [
        sent({ gmailId: "u1", threadId: "tu", to: "unsub@lists.x.com", origin: "unsubscribe" }),
        sent(),
      ],
      [],
      opts,
    );
    expect(out.map((i) => i.threadId)).toEqual(["t1"]);
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
    state.upsertError = null;
    state.upsertConflictsLeft = 0;
    state.listCalls = 0;
    state.sentRows = [];
    state.labels = new Map();
    state.classifyCalls = [];
    state.classifyFails = false;
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
    await expect(recordSentMessage("u1", sent())).resolves.toBe(false);
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

  it("a Klorn send records its origin on create and on update", async () => {
    await recordSentMessage("u1", { ...sent(), origin: "auto_reply" });
    expect(state.upserts[0]).toMatchObject({
      create: { origin: "auto_reply" },
      update: { origin: "auto_reply" },
    });
  });

  it("retries once when the Sent scan inserted the same row first, so the origin still lands", async () => {
    state.upsertConflictsLeft = 1;
    await recordSentMessage("u1", { ...sent(), origin: "approved" });
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0]).toMatchObject({ update: { origin: "approved" } });
    expect(state.captured).toEqual([]);
  });

  it("gives up after one retry and reports, never throwing", async () => {
    state.upsertConflictsLeft = 2;
    await expect(recordSentMessage("u1", { ...sent(), origin: "approved" })).resolves.toBe(false);
    expect(state.upserts).toHaveLength(0);
    expect(state.captured).toHaveLength(1);
  });

  it("a record without an origin never writes one, so the Sent scan cannot erase a Klorn origin", async () => {
    await recordSentMessage("u1", sent());
    const args = state.upserts[0] as { create: object; update: object };
    expect(args.create).not.toHaveProperty("origin");
    expect(args.update).not.toHaveProperty("origin");
  });

  it("rows from the Sent-folder scan carry no origin", async () => {
    await syncSentMessages("u1", NOW.getTime());
    const args = state.upserts[0] as { create: object; update: object };
    expect(args.create).not.toHaveProperty("origin");
    expect(args.update).not.toHaveProperty("origin");
  });

  it("an inferred origin is written on create only, so it never overwrites a send-time label", async () => {
    await recordSentMessage("u1", { ...sent(), inferredOrigin: "unsubscribe" });
    const args = state.upserts[0] as { create: object; update: object };
    expect(args.create).toMatchObject({ origin: "unsubscribe" });
    expect(args.update).not.toHaveProperty("origin");
  });

  it("a send-time origin wins over an inferred one", async () => {
    await recordSentMessage("u1", { ...sent(), origin: "user", inferredOrigin: "auto_reply" });
    expect(state.upserts[0]).toMatchObject({
      create: { origin: "user" },
      update: { origin: "user" },
    });
  });

  it("on a P2002 retry the update carries no inferred origin, so a send-time label that won the race stays", async () => {
    state.upsertConflictsLeft = 1;
    await recordSentMessage("u1", { ...sent(), inferredOrigin: "auto_reply" });
    const args = state.upserts[0] as { create: object; update: object };
    expect(args.update).not.toHaveProperty("origin");
  });

  it("sync classifies only the rows it is about to create and labels them on create", async () => {
    state.listResult = {
      items: [
        {
          gmailId: "known",
          threadId: "t0",
          to: "a@b.com",
          subject: "Old",
          receivedAt: "2026-09-09T00:00:00.000Z",
          inbox: "primary",
        },
        {
          gmailId: "g1",
          threadId: "t1",
          to: "unsub@list.com",
          subject: "unsubscribe",
          receivedAt: "2026-09-10T00:00:00.000Z",
          inbox: "primary",
        },
      ],
      nextPageToken: null,
    };
    state.sentRows = [{ gmailId: "known" }];
    state.labels = new Map([["g1", "unsubscribe"]]);
    expect(await syncSentMessages("u1", NOW.getTime())).toBe(2);
    expect(state.classifyCalls).toEqual([
      [
        {
          gmailId: "g1",
          to: "unsub@list.com",
          subject: "unsubscribe",
          sentAt: new Date("2026-09-10T00:00:00.000Z"),
          inbox: "primary",
        },
      ],
    ]);
    const [known, created] = state.upserts as { create: object; update: object }[];
    expect(known?.create).not.toHaveProperty("origin");
    expect(created?.create).toMatchObject({ gmailId: "g1", origin: "unsubscribe" });
    expect(created?.update).not.toHaveProperty("origin");
  });

  it("sync makes no classifier call when every row already exists", async () => {
    state.sentRows = [{ gmailId: "g1" }];
    await syncSentMessages("u1", NOW.getTime());
    expect(state.classifyCalls).toEqual([]);
    expect(state.upserts).toHaveLength(1);
  });

  it("when classification fails it still records the rows it had, and skips only the new ones", async () => {
    state.listResult = {
      items: [
        {
          gmailId: "known",
          threadId: "t0",
          to: "a@b.com",
          subject: "Old",
          receivedAt: "2026-09-09T00:00:00.000Z",
          inbox: "primary",
        },
        {
          gmailId: "new",
          threadId: "t1",
          to: "unsub@list.com",
          subject: "unsubscribe",
          receivedAt: "2026-09-10T00:00:00.000Z",
          inbox: "primary",
        },
      ],
      nextPageToken: null,
    };
    state.sentRows = [{ gmailId: "known" }];
    state.classifyFails = true;
    expect(await syncSentMessages("u1", NOW.getTime())).toBe(1);
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0]).toMatchObject({ create: { gmailId: "known" } });
    // One Sentry event, carrying the error's name and code only: a Prisma
    // message can quote the query's values (addresses).
    expect(state.captured).toHaveLength(1);
    const reported = state.captured[0] as Error;
    expect(reported.name).toBe("PrismaClientKnownRequestError");
    expect(reported.message).not.toContain("unsub@list.com");
    expect(vi.mocked(captureError).mock.calls.at(-1)?.[1]).toMatchObject({
      extra: { code: "P1001" },
    });
  });

  it("record stores at most 1,024 characters of to and subject, never half a surrogate pair", async () => {
    const to = `${"a".repeat(1_023)}\u{1F600}tail`;
    await recordSentMessage("u1", { ...sent(), to, subject: "s".repeat(5_000) });
    const args = state.upserts[0] as {
      create: { to: string; subject: string };
      update: { to: string; subject: string };
    };
    expect(args.create.subject).toHaveLength(1_024);
    expect(args.update.subject).toHaveLength(1_024);
    expect(args.create.to).toBe("a".repeat(1_023));
  });

  it("a write the data-wipe fence rejected is logged, never sent to Sentry (LOW-1)", async () => {
    const { DataWipeFenceError } = await import("../privacy/data-wipe-fence.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    state.upsertError = new DataWipeFenceError();
    expect(await recordSentMessage("u1", sent())).toBe(false);
    expect(state.captured).toEqual([]);
    expect(warn.mock.calls.flat().join(" ")).toContain("DataWipeFenceError");
    warn.mockRestore();
  });

  it("record reports whether the row was written", async () => {
    expect(await recordSentMessage("u1", sent())).toBe(true);
    state.upsertFails = true;
    expect(await recordSentMessage("u1", sent())).toBe(false);
  });

  it("sync skips a row whose date is not a date", async () => {
    state.listResult = {
      items: [
        {
          gmailId: "bad",
          threadId: "t1",
          to: "a@b.com",
          subject: "x",
          receivedAt: "not a date",
          inbox: "primary",
        },
      ],
      nextPageToken: null,
    };
    expect(await syncSentMessages("u1", NOW.getTime())).toBe(0);
    expect(state.upserts).toEqual([]);
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

  it("reads each row's origin so the rule can drop unsubscribe requests", async () => {
    const { prisma } = await import("../db.js");
    state.sentRows = [sent({ origin: "unsubscribe" })];
    expect(await waitingOnThreads("u1", { now: NOW, minDays: 2 })).toEqual([]);
    const call = vi.mocked(prisma.sentMessage.findMany).mock.calls.at(-1)?.[0] as {
      select: Record<string, boolean>;
    };
    expect(call.select.origin).toBe(true);
  });

  it("no sent rows → no reply query, empty result", async () => {
    state.sentRows = [];
    expect(await waitingOnThreads("u1", { now: NOW })).toEqual([]);
  });
});
