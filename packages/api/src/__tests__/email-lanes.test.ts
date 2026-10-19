/**
 * listLaneTiersByEmail — the batched AttentionItem→tier join behind the mail
 * list's lane chips. Chips are observability, not control flow: retired v1
 * vocabulary must never reach the wire (AUTO folds to QUEUE, CALL to PUSH via
 * normalizeTier), and a lookup failure degrades to "no chips", never a 500.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const captureError = vi.hoisted(() => vi.fn());
const queryRaw = vi.hoisted(() => vi.fn(async (_sql: unknown) => [] as unknown[]));
const executeRaw = vi.hoisted(() => vi.fn(async (_sql: unknown) => 0));

vi.mock("../db.js", () => {
  const prisma: Record<string, unknown> = {
    attentionItem: { findMany },
    $queryRaw: queryRaw,
    $executeRaw: executeRaw,
  };
  // The lane reads run inside withStatementTimeout's interactive transaction.
  prisma.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError }));

import {
  countEmailsByLane,
  foldLaneCounts,
  listLaneInfoByEmail,
  listLaneTiersByEmail,
  pageThreadsInLane,
} from "../judge/email-lanes.js";

beforeEach(() => {
  findMany.mockReset();
  findMany.mockResolvedValue([]);
  queryRaw.mockReset();
  queryRaw.mockResolvedValue([]);
  executeRaw.mockClear();
  captureError.mockClear();
});

/** Every $queryRaw call as its SQL text (placeholders as `?`) and bound values. */
function rawCalls(): Array<{ text: string; values: unknown[] }> {
  return queryRaw.mock.calls.map(([sql]) => {
    const { strings, values } = sql as { strings: string[]; values: unknown[] };
    return { text: strings.join("?").replace(/\s+/g, " "), values };
  });
}

const THREAD_KEY_SQL = `(COALESCE(e."linkedInboxAccountId", '') || ':' || COALESCE(e."threadId", e."id"))`;

describe("listLaneTiersByEmail", () => {
  it("maps email ids to their normalized lane", async () => {
    findMany.mockResolvedValue([
      { sourceId: "e1", tier: "PUSH" },
      { sourceId: "e2", tier: "SILENT" },
    ]);
    const map = await listLaneTiersByEmail("u1", ["e1", "e2", "e3"]);
    expect(map.get("e1")).toBe("PUSH");
    expect(map.get("e2")).toBe("SILENT");
    expect(map.has("e3")).toBe(false);
  });

  it("scopes the query to the user and EMAIL source", async () => {
    await listLaneTiersByEmail("u1", ["e1"]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "u1",
          source: "EMAIL",
          sourceId: { in: ["e1"] },
        }),
      }),
    );
  });

  it("folds the retired AUTO lane to QUEUE — never on the wire", async () => {
    findMany.mockResolvedValue([{ sourceId: "e1", tier: "AUTO" }]);
    const map = await listLaneTiersByEmail("u1", ["e1"]);
    expect(map.get("e1")).toBe("QUEUE");
  });

  it("folds the retired CALL lane to PUSH (normalizeTier)", async () => {
    findMany.mockResolvedValue([{ sourceId: "e1", tier: "CALL" }]);
    const map = await listLaneTiersByEmail("u1", ["e1"]);
    expect(map.get("e1")).toBe("PUSH");
  });

  it("skips the query entirely for an empty page", async () => {
    const map = await listLaneTiersByEmail("u1", []);
    expect(map.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("fails open: a lookup error yields no chips, not a thrown list", async () => {
    findMany.mockRejectedValue(new Error("db down"));
    const map = await listLaneTiersByEmail("u1", ["e1"]);
    expect(map.size).toBe(0);
    expect(captureError).toHaveBeenCalledTimes(1);
  });
});

describe("listLaneInfoByEmail", () => {
  it("returns the folded lane and the stored reason in one user-scoped query", async () => {
    findMany.mockResolvedValue([
      { sourceId: "e1", tier: "CALL", tierReason: "known_vip" },
      { sourceId: "e2", tier: "AUTO", tierReason: null },
      { sourceId: "e3", tier: "INFO" },
    ]);
    const map = await listLaneInfoByEmail("u1", ["e1", "e2", "e3", "e4"]);
    expect(map.get("e1")).toEqual({ tier: "PUSH", reason: "known_vip" });
    expect(map.get("e2")).toEqual({ tier: "QUEUE", reason: null });
    expect(map.get("e3")).toEqual({ tier: "INFO", reason: null });
    expect(map.has("e4")).toBe(false);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: "u1", source: "EMAIL", sourceId: { in: ["e1", "e2", "e3", "e4"] } },
      select: { sourceId: true, tier: true, tierReason: true },
    });
  });

  it("skips the query for an empty page", async () => {
    expect((await listLaneInfoByEmail("u1", [])).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("fails open: a lookup error yields no chips and no reasons", async () => {
    findMany.mockRejectedValue(new Error("db down"));
    const map = await listLaneInfoByEmail("u1", ["e1"]);
    expect(map.size).toBe(0);
    expect(captureError).toHaveBeenCalledTimes(1);
  });
});

describe("pageThreadsInLane", () => {
  it("groups the lane view by thread with DISTINCT ON + a window count, all values bound", async () => {
    queryRaw.mockResolvedValue([
      { id: "e9", threadCount: 3, total: 57 },
      { id: "e4", threadCount: 1, total: 57 },
    ]);
    const page = await pageThreadsInLane({
      userId: "u1",
      lane: "QUEUE",
      scope: { kind: "linked", id: "li-1" },
      search: "invoice",
      hideHandled: true,
      skip: 50,
      take: 50,
    });
    expect(page).toEqual({
      rows: [
        { id: "e9", threadCount: 3 },
        { id: "e4", threadCount: 1 },
      ],
      total: 57,
    });
    // One statement: the thread total rides the page as a window over the groups.
    const calls = rawCalls();
    expect(calls).toHaveLength(1);
    const [rows] = calls;
    expect(rows.text).toContain(`SELECT DISTINCT ON (${THREAD_KEY_SQL})`);
    expect(rows.text).toContain(`COUNT(*) OVER (PARTITION BY ${THREAD_KEY_SQL})`);
    expect(rows.text).toContain(`ORDER BY ${THREAD_KEY_SQL}, e."receivedAt" DESC, e."id" DESC`);
    expect(rows.text).toContain(
      `SELECT id, "threadCount", (COUNT(*) OVER ())::int AS total FROM grouped ORDER BY "receivedAt" DESC, id DESC LIMIT ? OFFSET ?`,
    );
    expect(rows.text).not.toContain("COUNT(DISTINCT");
    // The same view as the ungrouped page: lane join with the owner on both sides,
    // the account scope, search and the handled exclusion all apply before grouping.
    expect(rows.text).toContain(`a."sourceId" = e."id" AND a."userId" = e."userId"`);
    expect(rows.text).toContain(`e."linkedInboxAccountId" = ?`);
    expect(rows.text).toContain(`h."status" = 'DISMISSED'`);
    expect(rows.values).toEqual(expect.arrayContaining(["u1", "li-1", 50]));
    expect(rows.text).not.toContain("u1");
  });

  it("runs under a 3s statement timeout set before the page query", async () => {
    await pageThreadsInLane({
      userId: "u1",
      lane: "QUEUE",
      scope: { kind: "all" },
      skip: 0,
      take: 50,
    });
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const set = executeRaw.mock.calls[0]?.[0] as { strings: string[] };
    expect(set.strings.join("?")).toContain("SET LOCAL statement_timeout = 3000");
    expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      queryRaw.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("an empty first page is a total of 0 without a second scan", async () => {
    queryRaw.mockResolvedValue([]);
    const page = await pageThreadsInLane({
      userId: "u1",
      lane: "PUSH",
      scope: { kind: "all" },
      skip: 0,
      take: 50,
    });
    expect(page).toEqual({ rows: [], total: 0 });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("a page past the end still reports the real thread total (distinct-count fallback)", async () => {
    queryRaw.mockImplementation(async (sql: unknown) => {
      const text = (sql as { strings: string[] }).strings.join("?");
      return text.includes("COUNT(DISTINCT") ? [{ total: 12 }] : [];
    });
    const page = await pageThreadsInLane({
      userId: "u1",
      lane: "QUEUE",
      scope: { kind: "linked", id: "li-1" },
      skip: 100,
      take: 50,
    });
    expect(page).toEqual({ rows: [], total: 12 });
    const [, total] = rawCalls();
    expect(total.text).toContain(`SELECT COUNT(DISTINCT ${THREAD_KEY_SQL})::int AS total`);
    expect(total.values).toEqual(expect.arrayContaining(["u1", "li-1"]));
  });

  it("a cancelled statement surfaces as QueryTimeoutError", async () => {
    const { Prisma } = await import("@prisma/client");
    const { QueryTimeoutError } = await import("../db-statement-timeout.js");
    queryRaw.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("canceling statement due to statement timeout", {
        code: "P2010",
        clientVersion: "test",
        meta: { code: "57014" },
      }),
    );
    await expect(
      pageThreadsInLane({ userId: "u1", lane: "QUEUE", scope: { kind: "all" }, skip: 0, take: 50 }),
    ).rejects.toBeInstanceOf(QueryTimeoutError);
  });

  it("ALL is the view with no lane join", async () => {
    await pageThreadsInLane({
      userId: "u1",
      lane: "ALL",
      scope: { kind: "all" },
      skip: 0,
      take: 50,
    });
    for (const call of rawCalls()) expect(call.text).not.toContain(`"AttentionItem" a`);
  });

  it("an account that is not the caller's pages nothing without a query", async () => {
    const page = await pageThreadsInLane({
      userId: "u1",
      lane: "PUSH",
      scope: { kind: "unknown" },
      skip: 0,
      take: 50,
    });
    expect(page).toEqual({ rows: [], total: 0 });
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe("countEmailsByLane — threads per folded lane", () => {
  it("maps a.tier to its live lane in SQL and counts distinct threads per lane", async () => {
    queryRaw.mockResolvedValue([
      { tier: "QUEUE", total: 3, unread: 1, threads: 1 },
      { tier: "PUSH", total: 2, unread: 2, threads: 2 },
    ]);
    const counts = await countEmailsByLane("u1", { kind: "all" });
    // One thread whose messages are stored as null, AUTO and QUEUE is one
    // QUEUE row from SQL (grouped by the folded lane), so it counts once.
    expect(counts.QUEUE).toEqual({ total: 3, unread: 1, threads: 1 });
    expect(counts.PUSH).toEqual({ total: 2, unread: 2, threads: 2 });
    expect(counts.SILENT).toEqual({ total: 0, unread: 0, threads: 0 });

    const [call] = rawCalls();
    expect(call.text).toContain(
      `CASE WHEN a."tier" IN (?,?) THEN ? WHEN a."tier" IN (?) THEN ? WHEN a."tier" IN (?) THEN ? WHEN a."tier" IN (?) THEN ? ELSE ? END AS lane`,
    );
    expect(call.text).toContain(`COUNT(DISTINCT thread_key)::int AS threads`);
    expect(call.text).toContain(`${THREAD_KEY_SQL} AS thread_key`);
    expect(call.text).toContain(`GROUP BY lane`);
    expect(call.text).not.toContain(`GROUP BY a."tier"`);
    // CALL reads as PUSH; null / AUTO / anything unlisted falls to ELSE QUEUE.
    expect(call.values).toEqual([
      "PUSH",
      "CALL",
      "PUSH",
      "MEETING",
      "MEETING",
      "INFO",
      "INFO",
      "SILENT",
      "SILENT",
      "QUEUE",
      "u1",
    ]);
  });

  it("the CASE agrees with toLiveTier for every stored value, null and AUTO included", async () => {
    await countEmailsByLane("u1", { kind: "all" });
    const [call] = rawCalls();
    // Rebuild the CASE from its bound values and evaluate it like Postgres would.
    const [p1, c1, push, meeting, meetingLane, info, infoLane, silent, silentLane, fallback] =
      call.values as string[];
    const sqlLane = (tier: string | null): string => {
      if (tier === p1 || tier === c1) return push;
      if (tier === meeting) return meetingLane;
      if (tier === info) return infoLane;
      if (tier === silent) return silentLane;
      return fallback;
    };
    const { toLiveTier } = await import("../judge/tiers.js");
    for (const stored of [
      null,
      "AUTO",
      "QUEUE",
      "CALL",
      "PUSH",
      "MEETING",
      "INFO",
      "SILENT",
      "x",
    ]) {
      expect(sqlLane(stored)).toBe(toLiveTier(stored));
    }
  });

  it("foldLaneCounts keeps folded rows' threads and defaults a missing value to 0", () => {
    const counts = foldLaneCounts([
      { tier: "INFO", total: 5, unread: 1, threads: 4 },
      { tier: "SILENT", total: 1, unread: 0 },
    ]);
    expect(counts.INFO).toEqual({ total: 5, unread: 1, threads: 4 });
    expect(counts.SILENT).toEqual({ total: 1, unread: 0, threads: 0 });
  });
});
