/**
 * getDecisionMetrics must stay memory-bounded as the DecisionLabel ledger grows.
 * The trailing window bounds the DATE range but not the row count, so at high
 * fleet volume the read is additionally capped to the most-recent-N rows. These
 * tests pin the cap + ordering so a refactor can't reintroduce an unbounded
 * fleet-wide findMany (the OOM-at-scale hazard).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted so the spy exists before the hoisted vi.mock factory references it.
const { findMany } = vi.hoisted(() => ({ findMany: vi.fn(async () => [] as unknown[]) }));
vi.mock("../db.js", () => {
  const prisma = { decisionLabel: { findMany } };
  return { prisma, db: prisma };
});

import { getDecisionMetrics } from "../judge/decision-metrics.js";

const CAP = 50_000;
const row = () => ({ userId: "u", shownTier: "QUEUE", outcome: null, decidedBy: "llm" });

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
});

describe("getDecisionMetrics — bounded fleet read", () => {
  it("caps rows and orders most-recent-first so memory can't scale with ledger volume", async () => {
    await getDecisionMetrics({});
    const args = findMany.mock.calls[0][0] as { take?: number; orderBy?: unknown };
    expect(args.take).toBe(CAP);
    expect(args.orderBy).toEqual({ judgedAt: "desc" });
  });

  it("warns when the row cap is hit (metrics reflect only the most recent N)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    findMany.mockResolvedValueOnce(Array.from({ length: CAP }, row));
    await getDecisionMetrics({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${CAP}-row cap`));
    warn.mockRestore();
  });

  it("does not warn when the result is under the cap", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    findMany.mockResolvedValueOnce([row()]);
    await getDecisionMetrics({});
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
