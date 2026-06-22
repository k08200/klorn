/**
 * decision-metrics reader is source-aware: the same honest ledger read works
 * per channel. It defaults to EMAIL (preserving the admin route + the daily
 * calibration snapshot), and reads the GITHUB ledger when asked — so GitHub
 * firewall accuracy is measurable from real overrides, not email-only. The
 * summarizer math is covered by decision-metrics.test.ts; here we only pin the
 * source filter the query actually issues. Prisma is mocked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => {
  const prisma = { decisionLabel: { findMany: vi.fn() } };
  return { prisma, db: prisma };
});

import { prisma } from "../db.js";
import { getDecisionDailySummary, getDecisionMetrics } from "../decision-metrics.js";

const findMany = (prisma as unknown as { decisionLabel: { findMany: ReturnType<typeof vi.fn> } })
  .decisionLabel.findMany;

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
});

function lastWhereSource(): string | undefined {
  return findMany.mock.calls.at(-1)?.[0]?.where?.source;
}

describe("getDecisionMetrics source filter", () => {
  it("defaults to the EMAIL ledger", async () => {
    await getDecisionMetrics({});
    expect(lastWhereSource()).toBe("EMAIL");
  });

  it("reads the GITHUB ledger when source=GITHUB", async () => {
    await getDecisionMetrics({ source: "GITHUB" });
    expect(lastWhereSource()).toBe("GITHUB");
  });
});

describe("getDecisionDailySummary source filter", () => {
  const since = new Date("2026-06-20T00:00:00Z");
  const until = new Date("2026-06-21T00:00:00Z");

  it("defaults to the EMAIL ledger", async () => {
    await getDecisionDailySummary("user-1", since, until);
    expect(lastWhereSource()).toBe("EMAIL");
  });

  it("reads the GITHUB ledger when asked", async () => {
    await getDecisionDailySummary("user-1", since, until, "GITHUB");
    expect(lastWhereSource()).toBe("GITHUB");
  });
});
