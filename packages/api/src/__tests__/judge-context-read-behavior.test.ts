/**
 * Fetch path for the read-behavior fact: buildJudgeContext counts the
 * sender's recent mail (windowed) and how much of it the user actually read.
 *
 * Contract under test:
 *  - flag ON + enough sample → senderFacts.readBehavior = { read, total }
 *  - flag OFF → no readBehavior (and no query fired)
 *  - sample below READ_BEHAVIOR.minSample → null (one read tells nothing)
 *  - a query that throws → fail-soft to null, other channels intact
 *  - only this sender's mail counts. The From header is the sender's to write, so
 *    a spoofed display name ('"alice@corp.com" <x@evil.co>') or a substring
 *    address (malice@corp.com) must not move alice's read rate. With
 *    SENDER_ADDRESS_INDEX_ENABLED the count is equality on fromAddress; without it
 *    the window's candidate rows are re-checked on the parsed address in code.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const countMock = vi.hoisted(() => vi.fn());
const findManyMock = vi.hoisted(() => vi.fn());
const flagState = vi.hoisted(() => ({ on: true }));

vi.mock("../db.js", () => ({
  db: {
    attentionItem: { findMany: vi.fn(async () => []) },
    emailMessage: { findMany: findManyMock, count: countMock },
  },
  prisma: {},
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../learning/trust-score.js", () => ({ getTrustScore: vi.fn(async () => null) }));
vi.mock("../learning/sender-trait-store.js", () => ({
  getActiveSenderTraits: vi.fn(async () => []),
}));
vi.mock("../learning/learned-rule-store.js", () => ({
  getAppliedRulesForMatch: vi.fn(async () => []),
}));
vi.mock("../learning/interaction-graph.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../learning/interaction-graph.js")>();
  return {
    ...actual,
    getCachedInteractionGraph: vi.fn(async () => null),
    getCachedInteractionNode: vi.fn(async () => null),
  };
});
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return {
    ...actual,
    get CONTACT_ENGAGEMENT_IN_JUDGE() {
      return flagState.on;
    },
  };
});

import { buildJudgeContext } from "../judge/judge-context.js";

type Mail = { from: string; isRead: boolean };
let windowRows: Mail[] = [];
const INDEX_FLAG = "SENDER_ADDRESS_INDEX_ENABLED";
const savedIndex = process.env[INDEX_FLAG];

/** The read-behavior query is the one that selects isRead; every other channel gets []. */
const readBehaviorCalls = () =>
  findManyMock.mock.calls.filter(
    (call) => (call[0] as { select?: Record<string, boolean> })?.select?.isRead === true,
  );

const mails = (from: string, read: number, unread: number): Mail[] => [
  ...Array.from({ length: read }, () => ({ from, isRead: true })),
  ...Array.from({ length: unread }, () => ({ from, isRead: false })),
];

beforeEach(() => {
  countMock.mockReset();
  findManyMock.mockReset();
  windowRows = [];
  findManyMock.mockImplementation(async (args: { select?: Record<string, boolean> }) =>
    args?.select?.isRead === true ? windowRows : [],
  );
  flagState.on = true;
  delete process.env[INDEX_FLAG];
});
afterEach(() => {
  if (savedIndex === undefined) delete process.env[INDEX_FLAG];
  else process.env[INDEX_FLAG] = savedIndex;
});

describe("buildJudgeContext — read-behavior fact", () => {
  it("returns {read, total} when the flag is on and the sample is big enough", async () => {
    windowRows = mails("Indie Hackers <channing@indiehackers.com>", 1, 24);
    const ctx = await buildJudgeContext("user-1", {
      from: "Indie Hackers <channing@indiehackers.com>",
    });
    expect(ctx.senderFacts?.readBehavior).toEqual({ read: 1, total: 25 });
  });

  it("counts only this sender: a spoofed display name and a substring address do not", async () => {
    windowRows = [
      ...mails("Alice <alice@corp.com>", 3, 0),
      ...mails('"alice@corp.com" <x@evil.co>', 0, 6),
      ...mails("Mal <malice@corp.com>", 0, 6),
    ];
    const ctx = await buildJudgeContext("user-1", { from: "Alice <alice@corp.com>" });
    expect(ctx.senderFacts?.readBehavior).toEqual({ read: 3, total: 3 });
  });

  it("asks for the window's candidate rows, newest first and bounded", async () => {
    windowRows = mails("a_b@corp.com", 3, 0);
    await buildJudgeContext("user-1", { from: "a_b@corp.com" });
    const [args] = readBehaviorCalls()[0] as [Record<string, unknown>];
    expect(args).toMatchObject({
      where: {
        userId: "user-1",
        from: { contains: "a\\_b@corp.com", mode: "insensitive" },
        receivedAt: { gte: expect.any(Date) },
      },
      select: { from: true, isRead: true },
      orderBy: { receivedAt: "desc" },
    });
    expect(args.take).toBe(500);
    expect(countMock).not.toHaveBeenCalled();
  });

  it("matches the sender whatever the case of the header", async () => {
    windowRows = mails("Alice <ALICE@Corp.com>", 2, 1);
    const ctx = await buildJudgeContext("user-1", { from: "alice@corp.com" });
    expect(ctx.senderFacts?.readBehavior).toEqual({ read: 2, total: 3 });
  });

  it("with SENDER_ADDRESS_INDEX_ENABLED, counts on fromAddress equality", async () => {
    process.env[INDEX_FLAG] = "true";
    countMock.mockResolvedValueOnce(25).mockResolvedValueOnce(1);
    const ctx = await buildJudgeContext("user-1", { from: "Alice <alice@corp.com>" });
    expect(ctx.senderFacts?.readBehavior).toEqual({ read: 1, total: 25 });
    const wheres = countMock.mock.calls.map((call) => (call[0] as { where: unknown }).where);
    expect(wheres).toEqual([
      { userId: "user-1", fromAddress: "alice@corp.com", receivedAt: { gte: expect.any(Date) } },
      {
        userId: "user-1",
        fromAddress: "alice@corp.com",
        receivedAt: { gte: expect.any(Date) },
        isRead: true,
      },
    ]);
    expect(readBehaviorCalls()).toHaveLength(0);
  });

  it("returns no readBehavior when the flag is off", async () => {
    flagState.on = false;
    const ctx = await buildJudgeContext("user-1", {
      from: "Indie Hackers <channing@indiehackers.com>",
    });
    expect(ctx.senderFacts?.readBehavior ?? null).toBeNull();
    expect(countMock).not.toHaveBeenCalled();
    expect(readBehaviorCalls()).toHaveLength(0);
  });

  it("suppresses the fact below the minimum sample", async () => {
    windowRows = mails("Zeno from Resend <zeno@updates.resend.com>", 2, 0);
    const ctx = await buildJudgeContext("user-1", {
      from: "Zeno from Resend <zeno@updates.resend.com>",
    });
    expect(ctx.senderFacts?.readBehavior ?? null).toBeNull();
  });

  it("fails soft to null when the query throws", async () => {
    findManyMock.mockImplementation(async (args: { select?: Record<string, boolean> }) => {
      if (args?.select?.isRead === true) throw new Error("db down");
      return [];
    });
    const ctx = await buildJudgeContext("user-1", {
      from: "Zeno from Resend <zeno@updates.resend.com>",
    });
    expect(ctx.senderFacts?.readBehavior ?? null).toBeNull();
  });
});
