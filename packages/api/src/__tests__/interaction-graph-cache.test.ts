/**
 * getCachedInteractionNode — cache-only lookup used by the judge path.
 * Must NEVER rebuild the graph (a sync burst would fan out N mailbox
 * scans); stale or missing cache returns null instead.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const memoryFindUnique = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({
  prisma: {
    memory: { findUnique: memoryFindUnique },
  },
  db: {},
}));

vi.mock("../memory.js", () => ({
  remember: vi.fn(),
}));

import { getCachedInteractionNode } from "../interaction-graph.js";

const NOW = new Date("2026-06-12T00:00:00Z");
const HOURS = (n: number) => new Date(NOW.getTime() - n * 60 * 60 * 1000).toISOString();

function cacheRow(builtAt: string, nodes: unknown[]): { content: string } {
  return { content: JSON.stringify({ builtAt, nodes }) };
}

const ALICE = {
  email: "Alice@Corp.com",
  name: "Alice",
  score: 80,
  emailCount: 14,
  lastEmailDaysAgo: 2,
  upcomingMeetings: 1,
  tags: ["frequent"],
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  memoryFindUnique.mockReset();
});

describe("getCachedInteractionNode", () => {
  it("returns the node from a fresh cache, matching the address case-insensitively", async () => {
    memoryFindUnique.mockResolvedValue(cacheRow(HOURS(5), [ALICE]));
    const node = await getCachedInteractionNode("u1", "alice@corp.com");
    expect(node?.emailCount).toBe(14);
  });

  it("returns null when the cache is stale instead of rebuilding", async () => {
    memoryFindUnique.mockResolvedValue(cacheRow(HOURS(4 * 24), [ALICE]));
    const node = await getCachedInteractionNode("u1", "alice@corp.com");
    expect(node).toBeNull();
    // One Memory read, nothing else — no rebuild queries.
    expect(memoryFindUnique).toHaveBeenCalledTimes(1);
  });

  it("returns null when there is no cache row", async () => {
    memoryFindUnique.mockResolvedValue(null);
    expect(await getCachedInteractionNode("u1", "alice@corp.com")).toBeNull();
  });

  it("returns null for an address not in the cached graph", async () => {
    memoryFindUnique.mockResolvedValue(cacheRow(HOURS(5), [ALICE]));
    expect(await getCachedInteractionNode("u1", "stranger@nowhere.com")).toBeNull();
  });

  it("returns null on malformed cache content or a DB error", async () => {
    memoryFindUnique.mockResolvedValue({ content: "not json {" });
    expect(await getCachedInteractionNode("u1", "alice@corp.com")).toBeNull();
    memoryFindUnique.mockRejectedValue(new Error("db down"));
    expect(await getCachedInteractionNode("u1", "alice@corp.com")).toBeNull();
  });

  it("returns null for an empty address", async () => {
    expect(await getCachedInteractionNode("u1", "")).toBeNull();
    expect(memoryFindUnique).not.toHaveBeenCalled();
  });
});
