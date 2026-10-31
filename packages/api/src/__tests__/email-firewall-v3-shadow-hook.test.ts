/**
 * The v3 facts shadow hook in persistGmailEmail: off by default, runs after the
 * v2 judge on a new mail when JUDGE_V3_SHADOW is on, and never on a re-sync.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.hoisted(() => vi.fn());
const create = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({
  prisma: { emailMessage: { findUnique, create, update } },
  db: {},
}));
vi.mock("../judge/attention-mirror.js", () => ({ upsertAttentionForEmailJudgement: vi.fn() }));
vi.mock("../pim/commitment-ingestion.js", () => ({
  extractAndUpsertCommitmentsFromText: vi.fn(() => Promise.resolve()),
}));
vi.mock("../agentcore/email-action-trigger.js", () => ({
  scheduleAgentForActionableEmail: vi.fn(() => Promise.resolve()),
}));
vi.mock("../mail/email-attachments.js", () => ({
  analyzePendingEmailAttachments: vi.fn(() => Promise.resolve()),
  upsertEmailAttachments: vi.fn(() => Promise.resolve()),
}));
vi.mock("../mail/email-priority.js", () => ({
  classifyNeedsReplyFromSignals: vi.fn(() => ({ needsReply: false, reason: null, confidence: 0 })),
  classifyPriority: vi.fn(() => "NORMAL"),
}));
vi.mock("../mail/gmail.js", () => ({ markAsRead: vi.fn(() => Promise.resolve()) }));
vi.mock("../judge/judge-context.js", () => ({
  buildJudgeContext: vi.fn(() => Promise.resolve({})),
}));
vi.mock("../judge/judge-health.js", () => ({ recordJudgeSource: vi.fn() }));
vi.mock("../judge/keyword-policy.js", () => ({ isClearMarketing: vi.fn(() => false) }));
vi.mock("../llm/llm-credentials.js", () => ({
  getUserLlmCredentials: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("../judge/poc-judge.js", () => ({ judgeEmail: vi.fn(() => Promise.resolve("QUEUE")) }));
vi.mock("../resolve-user-email.js", () => ({
  resolveUserEmail: vi.fn(() => Promise.resolve("me@example.com")),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
const shadowEnabled = vi.hoisted(() => vi.fn(() => false));
const runFactsShadow = vi.hoisted(() => vi.fn(() => Promise.resolve("stored")));
vi.mock("../judge/v3/flags.js", () => ({ isJudgeV3ShadowEnabled: shadowEnabled }));
vi.mock("../judge/v3/shadow.js", () => ({
  runFactsShadow,
  shadowMailFromRaw: (emailId: string) => ({ emailId }),
}));

import { persistGmailEmail } from "../judge/email-firewall.js";
import type { GmailRawEmail } from "../mail/gmail-fetch.js";

function rawEmail(overrides: Partial<GmailRawEmail> = {}): GmailRawEmail {
  return {
    gmailId: "klorn:jane@klorn.ai:e1",
    threadId: null,
    from: "Sam <sam@example.com>",
    to: "jane@klorn.ai",
    cc: "",
    subject: "hello",
    snippet: "hi there",
    body: "hi there",
    htmlBody: "",
    labels: ["INBOX", "UNREAD"],
    isRead: false,
    isStarred: false,
    receivedAt: new Date("2026-10-22T10:00:00Z"),
    attachments: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(null);
  create.mockResolvedValue({ id: "e-new" });
  update.mockResolvedValue({ id: "e-existing" });
});

describe("persistGmailEmail — v3 facts shadow hook", () => {
  it("does not load or run the shadow while the flag is off", async () => {
    shadowEnabled.mockReturnValue(false);
    await persistGmailEmail("u1", rawEmail());
    await new Promise((r) => setTimeout(r, 20));
    expect(runFactsShadow).not.toHaveBeenCalled();
  });

  it("runs the shadow for a new mail after the v2 judge when the flag is on", async () => {
    shadowEnabled.mockReturnValue(true);
    await persistGmailEmail("u1", rawEmail());
    await vi.waitFor(() => expect(runFactsShadow).toHaveBeenCalledTimes(1));
    const [userId, mail] = runFactsShadow.mock.calls[0] as unknown as [string, { emailId: string }];
    expect(userId).toBe("u1");
    expect(mail.emailId).toBe("e-new");
  });

  it("never runs on a re-sync of an existing row", async () => {
    shadowEnabled.mockReturnValue(true);
    findUnique.mockResolvedValue({ id: "e-existing", body: "hi there", snippet: "hi there" });
    await persistGmailEmail("u1", rawEmail());
    await new Promise((r) => setTimeout(r, 20));
    expect(runFactsShadow).not.toHaveBeenCalled();
  });
});
