/**
 * Attention aging sweep (judge/attention-aging.ts) — pins the conservative
 * policy: resolve acted-elsewhere EMAIL items (email gone, or out of every
 * folder Klorn reads: INBOX, and SPAM for spam-lane intake), age out SILENT
 * (14d) and QUEUE/null-tier (30d), NEVER touch PUSH/AUTO or non-EMAIL sources
 * through the age path, and stamp every resolution with its rule so the sweep
 * can be undone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  attentionFindMany: vi.fn(),
  attentionUpdateMany: vi.fn(async () => ({ count: 0 })),
  emailFindMany: vi.fn(async () => []),
}));

vi.mock("../db.js", () => {
  const prisma = {
    attentionItem: { findMany: m.attentionFindMany, updateMany: m.attentionUpdateMany },
    emailMessage: { findMany: m.emailFindMany },
  };
  return { prisma, db: prisma };
});

const {
  sweepAttentionAging,
  resetActedScanCursor,
  AGING_RESOLVED_REASON,
  ACTED_SCAN_PAGE,
  ACTED_SCAN_MAX_PAGES,
  SILENT_MAX_AGE_DAYS,
  QUEUE_MAX_AGE_DAYS,
} = await import("../judge/attention-aging.js");

const NOW = new Date("2026-08-10T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

type UpdateArgs = { where: Record<string, unknown>; data: Record<string, unknown> };
const updateCalls = (): UpdateArgs[] =>
  m.attentionUpdateMany.mock.calls.map((c) => (c as unknown as [UpdateArgs])[0]);
/** The acted-path write: the only updateMany keyed by an explicit id list. */
const actedCall = (): UpdateArgs | undefined => updateCalls().find((c) => "id" in c.where);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ATTENTION_AGING_ENABLED", "true");
  resetActedScanCursor();
  m.attentionFindMany.mockResolvedValue([]);
  m.attentionUpdateMany.mockResolvedValue({ count: 0 });
  m.emailFindMany.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sweepAttentionAging — flag", () => {
  it("is a no-op while ATTENTION_AGING_ENABLED is off: no read, no write", async () => {
    vi.stubEnv("ATTENTION_AGING_ENABLED", "");

    const result = await sweepAttentionAging(NOW);

    expect(result).toEqual({ resolvedActed: 0, resolvedAged: 0 });
    expect(m.attentionFindMany).not.toHaveBeenCalled();
    expect(m.emailFindMany).not.toHaveBeenCalled();
    expect(m.attentionUpdateMany).not.toHaveBeenCalled();
  });
});

describe("sweepAttentionAging — acted elsewhere", () => {
  it("resolves items whose email vanished or left the INBOX, stamped as acted; keeps live INBOX mail", async () => {
    m.attentionFindMany.mockResolvedValueOnce([
      { id: "att-archived", userId: "u2", sourceId: "em-archived" },
      { id: "att-gone", userId: "u1", sourceId: "em-gone" },
      { id: "att-live", userId: "u1", sourceId: "em-live" },
    ]);
    m.emailFindMany.mockResolvedValueOnce([
      { id: "em-archived", labels: ["ARCHIVE"] },
      { id: "em-live", labels: ["INBOX", "UNREAD"] },
    ]);
    m.attentionUpdateMany.mockResolvedValueOnce({ count: 2 });

    const result = await sweepAttentionAging(NOW);

    expect(actedCall()).toEqual({
      where: { id: { in: ["att-archived", "att-gone"] }, status: "OPEN" },
      data: {
        status: "RESOLVED",
        resolvedAt: NOW,
        resolvedReason: AGING_RESOLVED_REASON.ACTED,
      },
    });
    expect(result.resolvedActed).toBe(2);
    // Every sweep query stays user-scoped (reconcile-path invariant).
    expect(m.emailFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: { in: ["u2", "u1"] } }),
      }),
    );
  });

  it("keeps a spam-lane item that is still in SPAM open — Klorn surfaced it on purpose", async () => {
    m.attentionFindMany.mockResolvedValueOnce([
      { id: "att-rescued", userId: "u1", sourceId: "em-rescued" },
    ]);
    m.emailFindMany.mockResolvedValueOnce([{ id: "em-rescued", labels: ["SPAM", "UNREAD"] }]);

    const result = await sweepAttentionAging(NOW);

    expect(actedCall()).toBeUndefined();
    expect(result.resolvedActed).toBe(0);
  });

  it("resolves a spam-lane item the user moved out of SPAM to the trash, or deleted", async () => {
    m.attentionFindMany.mockResolvedValueOnce([
      { id: "att-spam-trashed", userId: "u1", sourceId: "em-spam-trashed" },
      { id: "att-spam-deleted", userId: "u1", sourceId: "em-spam-deleted" },
      { id: "att-spam-kept", userId: "u1", sourceId: "em-spam-kept" },
    ]);
    m.emailFindMany.mockResolvedValueOnce([
      { id: "em-spam-trashed", labels: ["TRASH"] },
      { id: "em-spam-kept", labels: ["SPAM"] },
    ]);
    m.attentionUpdateMany.mockResolvedValueOnce({ count: 2 });

    const result = await sweepAttentionAging(NOW);

    expect(actedCall()?.where).toEqual({
      id: { in: ["att-spam-trashed", "att-spam-deleted"] },
      status: "OPEN",
    });
    expect(actedCall()?.data.resolvedReason).toBe(AGING_RESOLVED_REASON.ACTED);
    expect(result.resolvedActed).toBe(2);
  });

  it("keeps a spam-lane item the user marked not-spam (back in INBOX) open", async () => {
    m.attentionFindMany.mockResolvedValueOnce([
      { id: "att-not-spam", userId: "u1", sourceId: "em-not-spam" },
    ]);
    m.emailFindMany.mockResolvedValueOnce([{ id: "em-not-spam", labels: ["INBOX"] }]);

    await sweepAttentionAging(NOW);

    expect(actedCall()).toBeUndefined();
  });

  it("only ever scans OPEN EMAIL items for the acted path, in id order", async () => {
    await sweepAttentionAging(NOW);
    expect(m.attentionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "OPEN", source: "EMAIL" },
        orderBy: { id: "asc" },
        take: ACTED_SCAN_PAGE,
      }),
    );
  });

  it("pages past a full page of still-live items instead of rescanning the same head every tick", async () => {
    const livePage = Array.from({ length: ACTED_SCAN_PAGE }, (_, i) => ({
      id: `att-${String(i).padStart(4, "0")}`,
      userId: "u1",
      sourceId: `em-${i}`,
    }));
    m.attentionFindMany
      .mockResolvedValueOnce(livePage)
      .mockResolvedValueOnce([{ id: "att-zzzz", userId: "u1", sourceId: "em-archived" }]);
    m.emailFindMany
      .mockResolvedValueOnce(livePage.map((i) => ({ id: i.sourceId, labels: ["INBOX"] })))
      .mockResolvedValueOnce([{ id: "em-archived", labels: [] }]);
    m.attentionUpdateMany.mockResolvedValueOnce({ count: 1 });

    const result = await sweepAttentionAging(NOW);

    const pages = m.attentionFindMany.mock.calls.map((c) => (c as unknown as [UpdateArgs])[0]);
    expect(pages).toHaveLength(2);
    expect(pages[1]?.where).toEqual({
      status: "OPEN",
      source: "EMAIL",
      id: { gt: livePage[livePage.length - 1]?.id },
    });
    expect(actedCall()?.where).toEqual({ id: { in: ["att-zzzz"] }, status: "OPEN" });
    expect(result.resolvedActed).toBe(1);
  });

  it("bounds one tick and resumes from where it stopped on the next tick", async () => {
    const fullPage = (n: number) =>
      Array.from({ length: ACTED_SCAN_PAGE }, (_, i) => ({
        id: `p${String(n).padStart(3, "0")}-${String(i).padStart(4, "0")}`,
        userId: "u1",
        sourceId: `em-${n}-${i}`,
      }));
    m.attentionFindMany.mockImplementation(async () =>
      fullPage(m.attentionFindMany.mock.calls.length),
    );
    m.emailFindMany.mockImplementation(async (args: unknown) => {
      const ids = (args as { where: { id: { in: string[] } } }).where.id.in;
      return ids.map((id) => ({ id, labels: ["INBOX"] }));
    });

    await sweepAttentionAging(NOW);
    expect(m.attentionFindMany).toHaveBeenCalledTimes(ACTED_SCAN_MAX_PAGES);
    const lastOfTick = fullPage(ACTED_SCAN_MAX_PAGES).at(-1)?.id;

    m.attentionFindMany.mockClear();
    m.attentionFindMany.mockResolvedValueOnce([]);
    await sweepAttentionAging(NOW);
    const firstOfNextTick = (m.attentionFindMany.mock.calls[0] as unknown as [UpdateArgs])[0];
    expect(firstOfNextTick.where).toEqual({
      status: "OPEN",
      source: "EMAIL",
      id: { gt: lastOfTick },
    });
  });

  it("wraps to the start once the scan reaches the end", async () => {
    m.attentionFindMany.mockResolvedValueOnce([{ id: "att-a", userId: "u1", sourceId: "em-a" }]);
    m.emailFindMany.mockResolvedValueOnce([{ id: "em-a", labels: ["INBOX"] }]);
    await sweepAttentionAging(NOW);

    m.attentionFindMany.mockClear();
    await sweepAttentionAging(NOW);
    const first = (m.attentionFindMany.mock.calls[0] as unknown as [UpdateArgs])[0];
    expect(first.where).toEqual({ status: "OPEN", source: "EMAIL" });
  });
});

describe("sweepAttentionAging — age-out", () => {
  it("ages SILENT after 14d and QUEUE + legacy null tier after 30d — nothing else", async () => {
    await sweepAttentionAging(NOW);

    const ageCalls = updateCalls().map((c) => c.where);
    expect(ageCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "OPEN",
          source: "EMAIL",
          tier: "SILENT",
          surfacedAt: { lt: new Date(NOW.getTime() - SILENT_MAX_AGE_DAYS * DAY_MS) },
        }),
        expect.objectContaining({
          status: "OPEN",
          source: "EMAIL",
          tier: { in: ["QUEUE"] },
          surfacedAt: { lt: new Date(NOW.getTime() - QUEUE_MAX_AGE_DAYS * DAY_MS) },
        }),
        expect.objectContaining({
          status: "OPEN",
          source: "EMAIL",
          tier: null,
          surfacedAt: { lt: new Date(NOW.getTime() - QUEUE_MAX_AGE_DAYS * DAY_MS) },
        }),
      ]),
    );
    // PUSH/AUTO must never appear in any age-out where clause.
    for (const where of ageCalls) {
      expect(where.tier === "PUSH" || where.tier === "AUTO").toBe(false);
    }
  });

  it("stamps each age rule with its own reason so a rollback can target one rule", async () => {
    await sweepAttentionAging(NOW);

    const reasonByTier = new Map(
      updateCalls().map((c) => [JSON.stringify(c.where.tier), c.data.resolvedReason]),
    );
    expect(reasonByTier.get(JSON.stringify("SILENT"))).toBe(AGING_RESOLVED_REASON.SILENT);
    expect(reasonByTier.get(JSON.stringify({ in: ["QUEUE"] }))).toBe(AGING_RESOLVED_REASON.QUEUE);
    expect(reasonByTier.get(JSON.stringify(null))).toBe(AGING_RESOLVED_REASON.QUEUE);
    for (const call of updateCalls()) {
      expect(call.data).toEqual({
        status: "RESOLVED",
        resolvedAt: NOW,
        resolvedReason: expect.any(String),
      });
    }
  });

  it("uses one shared prefix for every aging reason (the rollback key)", () => {
    for (const reason of Object.values(AGING_RESOLVED_REASON)) {
      expect(reason.startsWith("aging:")).toBe(true);
    }
    expect(new Set(Object.values(AGING_RESOLVED_REASON)).size).toBe(3);
  });

  it("aggregates aged counts across the three lanes", async () => {
    m.attentionUpdateMany
      .mockResolvedValueOnce({ count: 5 }) // silent
      .mockResolvedValueOnce({ count: 3 }) // queue
      .mockResolvedValueOnce({ count: 2 }); // null tier
    const result = await sweepAttentionAging(NOW);
    expect(result.resolvedAged).toBe(10);
    expect(result.resolvedActed).toBe(0);
  });
});
