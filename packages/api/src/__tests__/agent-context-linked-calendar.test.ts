/**
 * The agent's LLM context lists the next week of calendar events. With
 * LINKED_CALENDAR_SYNC_ENABLED off it must read primary and LOCAL rows only (C2
 * kill switch: a linked event must not reach the model); with it on, an invite
 * present in the primary and a linked calendar is one line, not two.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
  eventFindMany: vi.fn(),
}));

vi.mock("../db.js", () => {
  const empty = vi.fn(async () => []);
  const prisma = {
    task: { findMany: empty },
    calendarEvent: { findMany: m.eventFindMany },
    reminder: { findMany: empty },
    note: { findMany: empty },
    notification: { count: vi.fn(async () => 0) },
    emailMessage: { findMany: empty },
    contact: { findMany: empty },
    agentLog: { findMany: empty },
    message: { findMany: empty },
    automationConfig: { findUnique: vi.fn(async () => ({ timezone: null })) },
  };
  return { prisma, db: prisma };
});
vi.mock("../agentcore/agent-proposal-dedup.js", () => ({
  getRecentProposalSuppressions: vi.fn(async () => []),
  formatRecentProposalSuppressions: vi.fn(() => ""),
  filterSuppressedContextItems: vi.fn((items: unknown[]) => ({ visible: items, hidden: 0 })),
}));
vi.mock("../agentcore/agent-email-context-filter.js", () => ({
  buildAgentEmailWhere: vi.fn(() => ({})),
}));
vi.mock("../mail/gmail.js", () => ({ isNoReplyAddress: vi.fn(() => false) }));
vi.mock("../untrusted.js", () => ({ wrapUntrusted: vi.fn((s: string) => s) }));

import { gatherUserContext } from "../agentcore/agent-context.js";

function row(id: string, sourceAccountId: string | null, title = "Quarterly planning review") {
  const start = new Date(Date.now() + 2 * 60 * 60_000);
  return {
    id,
    userId: "u1",
    title,
    description: null,
    location: null,
    meetingLink: null,
    startTime: start,
    endTime: new Date(start.getTime() + 60 * 60_000),
    allDay: false,
    provider: "GOOGLE",
    externalId: "g-invite",
    sourceAccountId,
    sourceKey: sourceAccountId ?? "primary",
  };
}

const whereOfCalendarQuery = () =>
  (m.eventFindMany.mock.calls.at(-1)?.[0] as { where: Record<string, unknown> }).where;

beforeEach(() => {
  vi.clearAllMocks();
  m.events = [];
  m.eventFindMany.mockImplementation(async () => m.events);
});
afterEach(() => {
  delete process.env.LINKED_CALENDAR_SYNC_ENABLED;
});

describe("gatherUserContext — linked calendar rows (C2)", () => {
  it("kill switch: reads primary and LOCAL rows only while the flag is off", async () => {
    delete process.env.LINKED_CALENDAR_SYNC_ENABLED;

    await gatherUserContext("u1");

    expect(whereOfCalendarQuery().sourceAccountId).toBeNull();
  });

  it("does not narrow the query once the flag is on", async () => {
    process.env.LINKED_CALENDAR_SYNC_ENABLED = "true";

    await gatherUserContext("u1");

    expect(whereOfCalendarQuery()).not.toHaveProperty("sourceAccountId");
  });

  it("lists an invite that is in the primary and a linked calendar once", async () => {
    process.env.LINKED_CALENDAR_SYNC_ENABLED = "true";
    m.events = [row("linked-copy", "acct-1"), row("primary-copy", null)];

    const ctx = await gatherUserContext("u1");

    expect(ctx.split("Quarterly planning review").length - 1).toBe(1);
  });

  it("still lists a linked-only event, and two different events with the same title", async () => {
    process.env.LINKED_CALENDAR_SYNC_ENABLED = "true";
    m.events = [
      row("linked-only", "acct-1", "Work standup"),
      { ...row("a", null), externalId: "g-a" },
      { ...row("b", null), externalId: "g-b" },
    ];

    const ctx = await gatherUserContext("u1");

    expect(ctx).toContain("Work standup");
    expect(ctx.split("Quarterly planning review").length - 1).toBe(2);
  });
});
