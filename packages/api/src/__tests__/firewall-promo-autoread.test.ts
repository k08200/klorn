/**
 * persistGmailEmail — promotional / marketing mail is auto-marked read in Gmail
 * so it never sits unread. Promotional-ONLY by product decision: QUEUE/PUSH/
 * AUTO and non-promotional SILENT keep their unread state + alerts. The gate is
 * the SAME deterministic signal the judge's fast-path uses (isClearMarketing),
 * so the two can't drift. The Gmail/judge pipeline is mocked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.hoisted(() => vi.fn(async () => null));
const create = vi.hoisted(() => vi.fn(async () => ({ id: "e1" })));
const update = vi.hoisted(() => vi.fn(async () => ({})));
const markAsRead = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const judgeEmail = vi.hoisted(() => vi.fn());
const upsert = vi.hoisted(() => vi.fn(async () => {}));
const scheduleAgent = vi.hoisted(() => vi.fn());
const captureError = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => {
  const prisma = { emailMessage: { findUnique, create, update } };
  return { prisma, db: prisma };
});
vi.mock("../gmail.js", () => ({ markAsRead }));
vi.mock("../poc-judge.js", () => ({ judgeEmail }));
vi.mock("../judge-context.js", () => ({ buildJudgeContext: vi.fn(async () => ({})) }));
vi.mock("../attention-mirror.js", () => ({ upsertAttentionForEmailJudgement: upsert }));
vi.mock("../email-action-trigger.js", () => ({ scheduleAgentForActionableEmail: scheduleAgent }));
vi.mock("../llm-credentials.js", () => ({ getUserLlmCredentials: vi.fn(async () => ({})) }));
vi.mock("../resolve-user-email.js", () => ({ resolveUserEmail: vi.fn(async () => "me@x.com") }));
vi.mock("../email-priority.js", () => ({
  classifyPriority: vi.fn(() => "NORMAL"),
  classifyNeedsReplyFromSignals: vi.fn(() => ({ needsReply: false, reason: null, confidence: 0 })),
}));
vi.mock("../commitment-ingestion.js", () => ({
  extractAndUpsertCommitmentsFromText: vi.fn(async () => {}),
}));
vi.mock("../email-attachments.js", () => ({
  upsertEmailAttachments: vi.fn(async () => {}),
  analyzePendingEmailAttachments: vi.fn(async () => 0),
}));
vi.mock("../sentry.js", () => ({ captureError }));

import { persistGmailEmail } from "../email-firewall.js";

function rawEmail(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    gmailId: "g-1",
    threadId: "t-1",
    from: "sender@x.com",
    to: "me@x.com",
    cc: null,
    subject: "Hello",
    snippet: "snippet",
    body: "body",
    htmlBody: null,
    labels: [] as string[],
    isRead: false,
    isStarred: false,
    receivedAt: new Date("2026-06-25T00:00:00Z"),
    attachments: [] as unknown[],
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: test fixture shape
  } as any;
}

beforeEach(() => {
  findUnique.mockReset();
  findUnique.mockResolvedValue(null);
  create.mockReset();
  create.mockResolvedValue({ id: "e1" });
  markAsRead.mockReset();
  markAsRead.mockResolvedValue({ success: true });
  judgeEmail.mockReset();
  judgeEmail.mockResolvedValue({ tier: "SILENT", reason: "promo", features: {}, source: "fast-path" });
  upsert.mockClear();
  scheduleAgent.mockClear();
  captureError.mockClear();
});

describe("persistGmailEmail — promotional auto mark-read", () => {
  it("marks a CATEGORY_PROMOTIONS email read in Gmail", async () => {
    await persistGmailEmail("u1", rawEmail({ labels: ["CATEGORY_PROMOTIONS"] }));
    await vi.waitFor(() => expect(markAsRead).toHaveBeenCalledTimes(1));
    expect(markAsRead).toHaveBeenCalledWith("u1", "g-1");
  });

  it("marks an explicit marketing-subject email read (unsubscribe marker)", async () => {
    await persistGmailEmail("u1", rawEmail({ subject: "Deals — unsubscribe anytime" }));
    await vi.waitFor(() => expect(markAsRead).toHaveBeenCalledTimes(1));
  });

  it("does NOT mark a normal (non-promotional) email read", async () => {
    judgeEmail.mockResolvedValue({ tier: "QUEUE", reason: "r", features: {}, source: "llm" });
    await persistGmailEmail("u1", rawEmail({ subject: "Re: contract", labels: ["INBOX"] }));
    // Let the fire-and-forget judge chain settle, then assert no mark-read.
    await vi.waitFor(() => expect(scheduleAgent).toHaveBeenCalled());
    expect(markAsRead).not.toHaveBeenCalled();
  });

  it("logs but does NOT captureError when Gmail is not connected (benign skip, no Sentry spam)", async () => {
    // markAsRead returns { error } (not a throw) when Gmail is disconnected —
    // an expected/keyless state, so it must stay a console signal only.
    markAsRead.mockResolvedValue({ error: "Gmail not connected." });
    await persistGmailEmail("u1", rawEmail({ labels: ["CATEGORY_PROMOTIONS"] }));
    await vi.waitFor(() => expect(markAsRead).toHaveBeenCalledTimes(1));
    expect(captureError).not.toHaveBeenCalled();
  });

  it("never lets a mark-read failure surface (best-effort, logged via captureError)", async () => {
    markAsRead.mockRejectedValueOnce(new Error("Gmail down"));
    const result = await persistGmailEmail("u1", rawEmail({ labels: ["CATEGORY_PROMOTIONS"] }));
    expect(result).toEqual({ emailId: "e1", isNew: true });
    await vi.waitFor(() => expect(captureError).toHaveBeenCalled());
    expect(captureError.mock.calls[0][1]).toMatchObject({
      tags: { scope: "firewall.promo_auto_read" },
    });
  });

  it("does not re-mark an already-persisted email (existing → no judge, no mark-read)", async () => {
    findUnique.mockResolvedValue({ id: "e1" });
    await persistGmailEmail("u1", rawEmail({ labels: ["CATEGORY_PROMOTIONS"] }));
    expect(judgeEmail).not.toHaveBeenCalled();
    expect(markAsRead).not.toHaveBeenCalled();
  });
});
