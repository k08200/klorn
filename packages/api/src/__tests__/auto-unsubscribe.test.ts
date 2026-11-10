/**
 * Auto-unsubscribe (AUTO_UNSUBSCRIBE_ENABLED, default OFF) — rides the promo
 * auto-read hook: SILENT tier + deterministic marketing signal + an RFC 8058
 * one-click target, and nothing else. Never mailto (sends as the user),
 * never the browser link, never when the flag is off.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../mail/activity-sync.js", () => ({
  ensureRecentMailSync: vi.fn(async () => {}),
}));

const findUnique = vi.hoisted(() => vi.fn(async () => null as unknown));
const create = vi.hoisted(() => vi.fn(async () => ({ id: "e1" })));
const judgeEmail = vi.hoisted(() => vi.fn());
const markAsRead = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const oneClickMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const scheduleAgent = vi.hoisted(() => vi.fn());
const reserveQuota = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true }) as { ok: boolean; reason?: string }),
);
const captureError = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => {
  const prisma = { emailMessage: { findUnique, create, update: vi.fn(async () => ({})) } };
  return { prisma, db: prisma };
});
vi.mock("../mail/gmail.js", () => ({ markAsRead }));
vi.mock("../judge/poc-judge.js", () => ({ judgeEmail }));
vi.mock("../judge/judge-context.js", () => ({ buildJudgeContext: vi.fn(async () => ({})) }));
vi.mock("../judge/attention-mirror.js", () => ({
  upsertAttentionForEmailJudgement: vi.fn(async () => {}),
}));
vi.mock("../agentcore/email-action-trigger.js", () => ({
  scheduleAgentForActionableEmail: scheduleAgent,
}));
vi.mock("../llm/llm-credentials.js", () => ({ getUserLlmCredentials: vi.fn(async () => ({})) }));
vi.mock("../resolve-user-email.js", () => ({ resolveUserEmail: vi.fn(async () => "me@x.com") }));
vi.mock("../mail/email-priority.js", () => ({
  classifyPriority: vi.fn(() => "NORMAL"),
  classifyNeedsReplyFromSignals: vi.fn(() => ({ needsReply: false, reason: null, confidence: 0 })),
}));
vi.mock("../pim/commitment-ingestion.js", () => ({
  extractAndUpsertCommitmentsFromText: vi.fn(async () => {}),
}));
vi.mock("../mail/email-attachments.js", () => ({
  upsertEmailAttachments: vi.fn(async () => {}),
  analyzePendingEmailAttachments: vi.fn(async () => 0),
}));
vi.mock("../sentry.js", () => ({ captureError }));
vi.mock("../mail/unsubscribe-quota.js", () => ({ reserveAutoUnsubscribe: reserveQuota }));
vi.mock("../mail/list-unsubscribe.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../mail/list-unsubscribe.js")>();
  return { ...original, executeOneClickUnsubscribe: oneClickMock };
});

import { persistGmailEmail } from "../judge/email-firewall.js";

function promoEmail(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    gmailId: "g-1",
    threadId: "t-1",
    from: "deals@shop.com",
    to: "me@x.com",
    cc: null,
    subject: "Big sale",
    snippet: "s",
    body: "b",
    htmlBody: null,
    labels: ["CATEGORY_PROMOTIONS"],
    isRead: false,
    isStarred: false,
    receivedAt: new Date("2026-06-25T00:00:00Z"),
    attachments: [] as unknown[],
    listUnsubscribeMailto: null,
    listUnsubscribeUrl: "https://shop.com/unsub",
    listUnsubscribeOneClick: true,
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: test fixture shape
  } as any;
}

beforeEach(() => {
  findUnique.mockReset();
  findUnique.mockResolvedValue(null);
  create.mockReset();
  create.mockResolvedValue({ id: "e1" });
  judgeEmail.mockReset();
  judgeEmail.mockResolvedValue({
    tier: "SILENT",
    reason: "promo",
    features: {},
    source: "fast-path",
  });
  markAsRead.mockClear();
  oneClickMock.mockClear();
  scheduleAgent.mockClear();
  reserveQuota.mockReset();
  reserveQuota.mockResolvedValue({ ok: true });
  captureError.mockClear();
  process.env.AUTO_UNSUBSCRIBE_ENABLED = "true";
});

afterEach(() => {
  delete process.env.AUTO_UNSUBSCRIBE_ENABLED;
});

describe("auto-unsubscribe hook", () => {
  it("one-click unsubscribes SILENT promotional mail when the flag is on", async () => {
    await persistGmailEmail("u1", promoEmail());
    await vi.waitFor(() => expect(oneClickMock).toHaveBeenCalledTimes(1));
    expect(oneClickMock).toHaveBeenCalledWith("https://shop.com/unsub");
    // The caps are asked first, for this user and this target.
    expect(reserveQuota).toHaveBeenCalledWith("u1", "https://shop.com/unsub");
  });

  it("sends nothing when a cap refuses", async () => {
    reserveQuota.mockResolvedValue({ ok: false, reason: "host-cap" });
    await persistGmailEmail("u1", promoEmail());
    await vi.waitFor(() => expect(reserveQuota).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(oneClickMock).not.toHaveBeenCalled();
  });

  it("fails closed: a quota error sends nothing and is captured", async () => {
    reserveQuota.mockRejectedValue(new Error("db down"));
    await persistGmailEmail("u1", promoEmail());
    await vi.waitFor(() =>
      expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
        tags: { scope: "firewall.auto_unsubscribe_quota" },
        extra: { userId: "u1" },
      }),
    );
    expect(oneClickMock).not.toHaveBeenCalled();
  });

  it("does nothing when the flag is off", async () => {
    delete process.env.AUTO_UNSUBSCRIBE_ENABLED;
    await persistGmailEmail("u1", promoEmail());
    await vi.waitFor(() => expect(markAsRead).toHaveBeenCalled());
    expect(oneClickMock).not.toHaveBeenCalled();
  });

  it("does nothing without an RFC 8058 target (mailto is never automatic)", async () => {
    await persistGmailEmail(
      "u1",
      promoEmail({
        listUnsubscribeOneClick: false,
        listUnsubscribeMailto: "mailto:unsub@shop.com",
      }),
    );
    await vi.waitFor(() => expect(markAsRead).toHaveBeenCalled());
    expect(oneClickMock).not.toHaveBeenCalled();
  });

  it("does nothing for a non-SILENT tier even with a target", async () => {
    judgeEmail.mockResolvedValue({ tier: "QUEUE", reason: "r", features: {}, source: "llm" });
    await persistGmailEmail("u1", promoEmail());
    await vi.waitFor(() => expect(scheduleAgent).toHaveBeenCalled());
    expect(oneClickMock).not.toHaveBeenCalled();
  });
});
