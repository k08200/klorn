/**
 * Screener (first-contact gate) unit tests.
 *
 * The screener does NOT add a sixth lane and does not hold mail. It notices
 * senders you have never heard from, lets you make one permanent call, and
 * writes a BLOCK into the pin ladder the judge already honours at rank 0.
 *
 * Prisma is mocked at the db.js boundary (repo convention); no real DB.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const emailCount = vi.hoisted(() => vi.fn());
const emailGroupBy = vi.hoisted(() => vi.fn());
const emailFindMany = vi.hoisted(() => vi.fn());
const decisionFindUnique = vi.hoisted(() => vi.fn());
const decisionFindMany = vi.hoisted(() => vi.fn());
const decisionUpsert = vi.hoisted(() => vi.fn());
const ruleCreate = vi.hoisted(() => vi.fn());
const ruleDeleteMany = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({
  db: {
    emailMessage: { count: emailCount, groupBy: emailGroupBy, findMany: emailFindMany },
    screenerDecision: {
      findUnique: decisionFindUnique,
      findMany: decisionFindMany,
      upsert: decisionUpsert,
    },
    emailRule: { create: ruleCreate, deleteMany: ruleDeleteMany },
  },
  prisma: {},
}));

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import {
  isFirstContact,
  isScreenerEnabled,
  listPendingScreener,
  recordScreenerDecision,
  screenerVerdictFor,
} from "../judge/screener.js";

const USER = "user-1";

beforeEach(() => {
  vi.clearAllMocks();
  emailCount.mockResolvedValue(0);
  emailGroupBy.mockResolvedValue([]);
  emailFindMany.mockResolvedValue([]);
  decisionFindUnique.mockResolvedValue(null);
  decisionFindMany.mockResolvedValue([]);
  decisionUpsert.mockResolvedValue({});
  ruleCreate.mockResolvedValue({});
  ruleDeleteMany.mockResolvedValue({ count: 0 });
  process.env.SCREENER_ENABLED = "true";
});

describe("isScreenerEnabled", () => {
  it("is off unless the flag is exactly 'true'", () => {
    process.env.SCREENER_ENABLED = undefined as unknown as string;
    delete process.env.SCREENER_ENABLED;
    expect(isScreenerEnabled()).toBe(false);

    process.env.SCREENER_ENABLED = "1";
    expect(isScreenerEnabled()).toBe(false);

    process.env.SCREENER_ENABLED = "true";
    expect(isScreenerEnabled()).toBe(true);
  });
});

describe("isFirstContact", () => {
  it("is true when the sender has no earlier message", async () => {
    emailCount.mockResolvedValue(0);
    await expect(isFirstContact(USER, "New.Person@Example.com")).resolves.toBe(true);
  });

  it("is false once any earlier message exists", async () => {
    emailCount.mockResolvedValue(3);
    await expect(isFirstContact(USER, "known@example.com")).resolves.toBe(false);
  });

  it("normalises the address before querying, so casing cannot split a sender", async () => {
    await isFirstContact(USER, "  New.Person@EXAMPLE.com ");
    expect(emailCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: USER, fromAddress: "new.person@example.com" }),
      }),
    );
  });

  it("treats a blank address as known, never as a new contact to screen", async () => {
    await expect(isFirstContact(USER, "")).resolves.toBe(false);
    expect(emailCount).not.toHaveBeenCalled();
  });

  it("fails open — a DB error must not turn every sender into a first contact", async () => {
    emailCount.mockRejectedValue(new Error("db down"));
    await expect(isFirstContact(USER, "someone@example.com")).resolves.toBe(false);
  });
});

describe("screenerVerdictFor", () => {
  it("returns the stored verdict", async () => {
    decisionFindUnique.mockResolvedValue({ verdict: "BLOCK" });
    await expect(screenerVerdictFor(USER, "spam@example.com")).resolves.toBe("BLOCK");
  });

  it("returns null when the sender has never been screened", async () => {
    await expect(screenerVerdictFor(USER, "nobody@example.com")).resolves.toBeNull();
  });

  it("fails open to null on a DB error", async () => {
    decisionFindUnique.mockRejectedValue(new Error("db down"));
    await expect(screenerVerdictFor(USER, "x@example.com")).resolves.toBeNull();
  });
});

describe("recordScreenerDecision", () => {
  it("BLOCK writes a PIN_TIER -> SILENT rule, so the existing rank-0 ladder enforces it", async () => {
    await recordScreenerDecision(USER, "Spam@Example.com", "BLOCK");

    expect(ruleCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: USER,
          actionType: "PIN_TIER",
          actionValue: "SILENT",
          isActive: true,
          conditions: { from: ["spam@example.com"] },
        }),
      }),
    );
  });

  it("BLOCK records the decision under the normalised address", async () => {
    await recordScreenerDecision(USER, "Spam@Example.com", "BLOCK");
    expect(decisionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_sender: { userId: USER, sender: "spam@example.com" } },
        create: expect.objectContaining({ sender: "spam@example.com", verdict: "BLOCK" }),
        update: expect.objectContaining({ verdict: "BLOCK" }),
      }),
    );
  });

  it("ALLOW records the decision but pins nothing — the classifier still decides the lane", async () => {
    await recordScreenerDecision(USER, "friend@example.com", "ALLOW");
    expect(decisionUpsert).toHaveBeenCalledTimes(1);
    expect(ruleCreate).not.toHaveBeenCalled();
  });

  it("re-deciding ALLOW after a BLOCK removes the pin it created", async () => {
    await recordScreenerDecision(USER, "friend@example.com", "ALLOW");
    expect(ruleDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: USER, actionType: "PIN_TIER" }),
      }),
    );
  });

  it("rejects a blank sender rather than writing a rule that matches nothing", async () => {
    await expect(recordScreenerDecision(USER, "   ", "BLOCK")).rejects.toThrow(/sender/i);
    expect(ruleCreate).not.toHaveBeenCalled();
    expect(decisionUpsert).not.toHaveBeenCalled();
  });
});

describe("listPendingScreener", () => {
  const recent = new Date("2026-08-20T00:00:00Z");

  it("returns undecided first-contact senders newest first", async () => {
    emailGroupBy.mockResolvedValue([
      { fromAddress: "a@example.com", _count: { _all: 1 }, _max: { receivedAt: recent } },
      {
        fromAddress: "b@example.com",
        _count: { _all: 2 },
        _max: { receivedAt: new Date("2026-08-22T00:00:00Z") },
      },
    ]);

    const pending = await listPendingScreener(USER);
    expect(pending.map((p) => p.sender)).toEqual(["b@example.com", "a@example.com"]);
    expect(pending[0]).toMatchObject({ sender: "b@example.com", messageCount: 2 });
  });

  it("drops senders that already have a decision", async () => {
    emailGroupBy.mockResolvedValue([
      { fromAddress: "decided@example.com", _count: { _all: 1 }, _max: { receivedAt: recent } },
      { fromAddress: "fresh@example.com", _count: { _all: 1 }, _max: { receivedAt: recent } },
    ]);
    decisionFindMany.mockResolvedValue([{ sender: "decided@example.com" }]);

    const pending = await listPendingScreener(USER);
    expect(pending.map((p) => p.sender)).toEqual(["fresh@example.com"]);
  });

  it("scopes the query by recency, so linking an inbox does not screen the whole backfill", async () => {
    await listPendingScreener(USER);
    const where = emailGroupBy.mock.calls[0][0].where;
    expect(where.receivedAt.gte).toBeInstanceOf(Date);
  });

  it("fails open to an empty list on a DB error", async () => {
    emailGroupBy.mockRejectedValue(new Error("db down"));
    await expect(listPendingScreener(USER)).resolves.toEqual([]);
  });
});

/**
 * Regression: the pending list re-checked each candidate with "has 0 messages
 * from this sender", but every candidate comes from a groupBy over those same
 * messages, so each had at least one and the list was always empty. First
 * contact means the sender's FIRST message falls inside the window — no mail
 * from them before it. These run against an in-memory table that honours the
 * where clauses, so the two queries have to agree the way they do in Postgres.
 */
describe("listPendingScreener — first contact against message history", () => {
  type Msg = { userId: string; fromAddress: string; receivedAt: Date };
  const DAY = 24 * 60 * 60 * 1000;
  const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
  let messages: Msg[] = [];

  type DateFilter = { gte?: Date; lt?: Date };
  type MsgWhere = {
    userId: string;
    receivedAt?: DateFilter;
    fromAddress?: { in?: string[]; not?: null };
  };
  const matches = (m: Msg, where: MsgWhere) =>
    m.userId === where.userId &&
    (!where.receivedAt?.gte || m.receivedAt >= where.receivedAt.gte) &&
    (!where.receivedAt?.lt || m.receivedAt < where.receivedAt.lt) &&
    (!where.fromAddress?.in || where.fromAddress.in.includes(m.fromAddress));

  beforeEach(() => {
    messages = [];
    emailGroupBy.mockImplementation(async ({ where }: { where: MsgWhere }) => {
      const bySender = new Map<string, Msg[]>();
      for (const m of messages.filter((x) => matches(x, where))) {
        bySender.set(m.fromAddress, [...(bySender.get(m.fromAddress) ?? []), m]);
      }
      return [...bySender].map(([fromAddress, rows]) => ({
        fromAddress,
        _count: { _all: rows.length },
        _max: { receivedAt: new Date(Math.max(...rows.map((r) => r.receivedAt.getTime()))) },
      }));
    });
    emailFindMany.mockImplementation(async ({ where }: { where: MsgWhere }) => {
      const seen = new Set(messages.filter((x) => matches(x, where)).map((m) => m.fromAddress));
      return [...seen].map((fromAddress) => ({ fromAddress }));
    });
    // The old check: any message at all from this sender, for this user.
    emailCount.mockImplementation(
      async ({ where }: { where: { userId: string; fromAddress: string } }) =>
        messages.filter((m) => m.userId === where.userId && m.fromAddress === where.fromAddress)
          .length,
    );
  });

  it("lists a sender whose only message arrived inside the window", async () => {
    messages = [{ userId: USER, fromAddress: "new@example.com", receivedAt: daysAgo(2) }];

    const pending = await listPendingScreener(USER);

    expect(pending.map((p) => p.sender)).toEqual(["new@example.com"]);
    expect(pending[0]?.messageCount).toBe(1);
  });

  it("still lists a new sender who has written several times inside the window", async () => {
    const latest = daysAgo(1);
    messages = [
      { userId: USER, fromAddress: "new@example.com", receivedAt: daysAgo(5) },
      { userId: USER, fromAddress: "new@example.com", receivedAt: latest },
    ];

    const pending = await listPendingScreener(USER);

    expect(pending).toEqual([
      { sender: "new@example.com", messageCount: 2, lastReceivedAt: latest },
    ]);
  });

  it("does not list a repeat sender who wrote before the window", async () => {
    messages = [
      { userId: USER, fromAddress: "old@example.com", receivedAt: daysAgo(200) },
      { userId: USER, fromAddress: "old@example.com", receivedAt: daysAgo(3) },
      { userId: USER, fromAddress: "new@example.com", receivedAt: daysAgo(3) },
    ];

    const pending = await listPendingScreener(USER);

    expect(pending.map((p) => p.sender)).toEqual(["new@example.com"]);
  });

  it("does not list a first-contact sender the user already decided on", async () => {
    messages = [
      { userId: USER, fromAddress: "blocked@example.com", receivedAt: daysAgo(1) },
      { userId: USER, fromAddress: "new@example.com", receivedAt: daysAgo(2) },
    ];
    decisionFindMany.mockResolvedValue([{ sender: "blocked@example.com" }]);

    const pending = await listPendingScreener(USER);

    expect(pending.map((p) => p.sender)).toEqual(["new@example.com"]);
  });

  it("judges first contact per user — another user's history does not count", async () => {
    messages = [
      // Another user has known this sender for months …
      { userId: "user-2", fromAddress: "shared@example.com", receivedAt: daysAgo(300) },
      // … but for USER it is a first contact.
      { userId: USER, fromAddress: "shared@example.com", receivedAt: daysAgo(1) },
    ];

    expect((await listPendingScreener(USER)).map((p) => p.sender)).toEqual(["shared@example.com"]);
    // And USER's mail never leaks into user-2's list (theirs is a long-standing sender).
    expect(await listPendingScreener("user-2")).toEqual([]);
    for (const call of emailFindMany.mock.calls) {
      expect(call[0].where.userId).toBeDefined();
    }
  });
});
