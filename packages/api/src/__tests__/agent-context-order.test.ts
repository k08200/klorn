/**
 * gatherUserContext section ordering — prompt-prefix cache hygiene.
 *
 * The agent context is re-sent every scheduler tick. Provider-side prompt
 * caching (OpenAI automatic, Gemini implicit) works on PREFIX match, so a
 * second-precision timestamp as the FIRST section busts the cache for
 * every byte after it on every call. The volatile "Current Time" section
 * must therefore come LAST.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const emptyMany = vi.hoisted(() => vi.fn(async () => []));
const zeroCount = vi.hoisted(() => vi.fn(async () => 0));

vi.mock("../db.js", () => {
  const prisma = {
    task: { findMany: emptyMany },
    calendarEvent: { findMany: emptyMany },
    reminder: { findMany: emptyMany },
    note: { findMany: emptyMany },
    notification: { count: zeroCount },
    emailMessage: { findMany: emptyMany },
    contact: { findMany: emptyMany },
    agentLog: { findMany: emptyMany },
    message: { findMany: emptyMany },
  };
  return { prisma, db: prisma };
});

vi.mock("../agent-proposal-dedup.js", () => ({
  getRecentProposalSuppressions: vi.fn(async () => []),
  formatRecentProposalSuppressions: vi.fn(() => ""),
  filterSuppressedContextItems: vi.fn((items: unknown[]) => ({ visible: items, hidden: 0 })),
}));

vi.mock("../agent-email-context-filter.js", () => ({
  buildAgentEmailWhere: vi.fn(() => ({})),
}));

vi.mock("../gmail.js", () => ({
  isNoReplyAddress: vi.fn(() => false),
}));

vi.mock("../untrusted.js", () => ({
  wrapUntrusted: vi.fn((s: string) => s),
}));

import { gatherUserContext } from "../agent-context.js";

beforeEach(() => {
  emptyMany.mockClear();
  zeroCount.mockClear();
});

describe("gatherUserContext — cache-friendly section order", () => {
  it("puts the volatile Current Time section after every other section", async () => {
    const ctx = await gatherUserContext("u1");
    const timeIdx = ctx.indexOf("## Current Time");
    expect(timeIdx).toBeGreaterThan(-1);

    const otherHeadings = ctx
      .split("\n")
      .filter((line) => line.startsWith("## ") && !line.startsWith("## Current Time"));
    expect(otherHeadings.length).toBeGreaterThan(0);
    for (const heading of otherHeadings) {
      expect(timeIdx).toBeGreaterThan(ctx.indexOf(heading));
    }
  });

  it("still carries both KST and UTC timestamps", async () => {
    const ctx = await gatherUserContext("u1");
    expect(ctx).toContain("KST: ");
    expect(ctx).toContain("UTC: ");
  });
});
