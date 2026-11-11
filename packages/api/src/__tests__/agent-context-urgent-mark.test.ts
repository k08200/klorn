/**
 * gatherAgentContext hands the run the mails it numbers "Email #N", in that
 * order, and marks a mail that already rang the user as urgent mail so the
 * model leaves it to that ring (agent-urgent-overlap.ts; the notify_user
 * handler enforces it either way).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const emptyMany = vi.hoisted(() => vi.fn(async () => []));
const emailFindMany = vi.hoisted(() => vi.fn());
const notificationFindMany = vi.hoisted(() => vi.fn());
const automationConfigFindUnique = vi.hoisted(() => vi.fn(async () => ({ timezone: null })));

vi.mock("../db.js", () => {
  const prisma = {
    task: { findMany: emptyMany },
    calendarEvent: { findMany: emptyMany },
    reminder: { findMany: emptyMany },
    note: { findMany: emptyMany },
    notification: { count: vi.fn(async () => 0), findMany: notificationFindMany },
    emailMessage: { findMany: emailFindMany },
    contact: { findMany: emptyMany },
    agentLog: { findMany: emptyMany },
    message: { findMany: emptyMany },
    automationConfig: { findUnique: automationConfigFindUnique },
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

vi.mock("../mail/gmail.js", () => ({
  isNoReplyAddress: vi.fn((from: string) => from.includes("noreply@")),
}));

vi.mock("../untrusted.js", () => ({
  wrapUntrusted: vi.fn((s: string) => s),
}));

import { gatherAgentContext, gatherUserContext } from "../agentcore/agent-context.js";

const now = new Date();

function mail(id: string, from: string, subject: string) {
  return {
    id,
    gmailId: `g-${id}`,
    from,
    subject,
    snippet: subject,
    body: null,
    summary: null,
    category: null,
    priority: "NORMAL",
    actionItems: null,
    isRead: false,
    receivedAt: now,
    createdAt: now,
  };
}

const MARK = "ALREADY PUSHED AS URGENT";

beforeEach(() => {
  vi.clearAllMocks();
  automationConfigFindUnique.mockResolvedValue({ timezone: null });
  emailFindMany.mockResolvedValue([
    mail("quote", "Kim <kim@vendor.example>", "견적서 최종 확인"),
    mail("robot", "noreply@service.example", "Your receipt"),
    mail("lunch", "Jin <jin@team.example>", "Lunch moved"),
  ]);
  notificationFindMany.mockResolvedValue([
    { sourceEmailId: "quote", message: "Kim: 견적서 최종 확인 [g-quote]", createdAt: now },
  ]);
});

describe("gatherAgentContext — the numbered context mails", () => {
  it("returns the mails in Email #N order, without the ones the prompt leaves out", async () => {
    const { text, emails } = await gatherAgentContext("u1");

    expect(emails.map((e) => e.id)).toEqual(["quote", "lunch"]);
    expect(emails[0]).toEqual({ id: "quote", gmailId: "g-quote", createdAt: now });
    expect(text).toMatch(/### Email #1 [^\n]*\n {2}From: Kim/);
    expect(text).toMatch(/### Email #2 [^\n]*\n {2}From: Jin/);
  });

  it("marks only the mail that already rang as urgent mail", async () => {
    const { text } = await gatherAgentContext("u1");

    const headings = text.split("\n").filter((line) => line.startsWith("### Email #"));
    expect(headings).toHaveLength(2);
    expect(headings[0]).toContain(MARK);
    expect(headings[1]).not.toContain(MARK);
  });

  it("a failed urgent-row lookup leaves the mail unmarked, not the context empty", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    notificationFindMany.mockRejectedValue(new Error("db down"));

    const { text, emails } = await gatherAgentContext("u1");

    expect(emails).toHaveLength(2);
    expect(text).toContain("### Email #1");
    expect(text).not.toContain(MARK);
  });

  it("gatherUserContext is the same text", async () => {
    const text = await gatherUserContext("u1");
    expect(text).toContain(`### Email #1`);
    expect(text).toContain(MARK);
  });
});
