/**
 * Step B3 leaves the deterministic floor exactly where it was: `send_email` on
 * the agent/chat tool path needs a verified ActionReceipt whatever mailbox it
 * is bound for. An IMAP (Naver) account reached through `in_reply_to_email_id`
 * is refused without a receipt, and with a stale receipt, exactly as a Gmail
 * account is (see tool-executor-floor.test.ts) — and no SMTP transport or IMAP
 * client is constructed before the refusal.
 *
 * With a valid receipt the send reaches the IMAP provider implementation (flag
 * ON) or the unchanged `unsupported` answer (flag OFF).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActionReceiptMismatchError,
  mintReceipt,
  sendEmailPayloadHash,
} from "../judge/attention-floor.js";

const h = vi.hoisted(() => ({
  createTransport: vi.fn(),
  sendMail: vi.fn(),
  imapCtor: vi.fn(),
  connect: vi.fn(),
  emailFindFirst: vi.fn(),
  linkedFindFirst: vi.fn(),
}));

const NAVER_ROW = {
  id: "row-1",
  email: "me@naver.com",
  imapHost: "imap.naver.com:993",
  imapPasswordCipher: "v2:k:iv:ct:tag",
};

vi.mock("nodemailer", () => ({ createTransport: h.createTransport }));
vi.mock("imapflow", () => ({
  ImapFlow: class {
    constructor(opts: unknown) {
      h.imapCtor(opts);
    }
    connect = h.connect;
    on = vi.fn();
    list = vi.fn(async () => []);
    getMailboxLock = vi.fn(async () => ({ release: vi.fn() }));
    search = vi.fn(async () => []);
    append = vi.fn(async () => ({ destination: "Sent" }));
    logout = vi.fn(async () => undefined);
    close = vi.fn();
  },
}));
vi.mock("../crypto-tokens.js", () => ({ decryptToken: () => "app-pw" }));
vi.mock("../mail/gmail.js", () => ({
  GMAIL_TOOLS: [],
  sendEmail: vi.fn(),
  listEmails: vi.fn(),
  readEmail: vi.fn(),
  markAsRead: vi.fn(),
  classifyEmails: vi.fn(),
}));
vi.mock("../db.js", () => ({
  prisma: {
    emailMessage: { findFirst: h.emailFindFirst, updateMany: vi.fn(async () => ({ count: 1 })) },
    linkedInboxAccount: { findFirst: h.linkedFindFirst },
  },
  db: {},
}));
vi.mock("../pim/calendar.js", () => ({
  CALENDAR_TOOLS: [],
  createEvent: vi.fn(),
  deleteEvent: vi.fn(),
  listEvents: vi.fn(),
  checkConflicts: vi.fn(),
}));
vi.mock("../pim/meeting.js", () => ({
  MEETING_TOOLS: [],
  getUpcomingMeetings: vi.fn(),
  joinMeeting: vi.fn(),
  summarizeMeeting: vi.fn(),
}));
vi.mock("../pim/briefing.js", () => ({ BRIEFING_TOOLS: [] }));
vi.mock("../learning/memory.js", () => ({
  MEMORY_TOOLS: [],
  forget: vi.fn(),
  recall: vi.fn(),
  remember: vi.fn(),
}));
vi.mock("../agentcore/skill-executor.js", () => ({
  SKILL_TOOLS: [],
  executeSkill: vi.fn(),
  listUserSkills: vi.fn(),
}));
vi.mock("../agentcore/skill-recorder.js", () => ({ recordSkill: vi.fn() }));
vi.mock("../judge/attention-mirror.js", () => ({
  upsertAttentionForCalendarEvent: vi.fn(),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../agentcore/agent-mode.js", () => ({ AGENT_MODES: [] }));
vi.mock("../billing/stripe.js", () => ({
  planHasFeature: () => true,
  TOOL_FEATURE_MAP: {},
}));
vi.mock("../agentcore/tool-result-budget.js", () => ({
  capToolResult: (s: string) => s,
}));
vi.mock("../untrusted.js", () => ({ wrapUntrusted: (s: string) => s }));
vi.mock("../utilities.js", () => ({
  UTILITY_TOOLS: [],
  calculate: vi.fn(),
  convertCurrency: vi.fn(),
  generatePassword: vi.fn(),
  shortenUrl: vi.fn(),
  translate: vi.fn(),
}));

const { executeToolCall, FloorReceiptRequiredError } = await import(
  "../agentcore/tool-executor.js"
);

const userId = "user-1";
const args = {
  to: "alice@example.com",
  subject: "Re: Q3 plan",
  body: "Sounds good.",
  in_reply_to_email_id: "email-42",
};
const PAYLOAD = { to: args.to, subject: args.subject, body: args.body };

const FLAGS = ["IMAP_SEND_ENABLED", "IMAP_ACTIONS_ENABLED", "ICLOUD_INBOX_ENABLED"] as const;
const original = Object.fromEntries(FLAGS.map((name) => [name, process.env[name]]));

const receiptFor = (payload: { to: string; subject: string; body: string }) =>
  mintReceipt({
    action: "send_email",
    inputHash: "",
    payloadHash: sendEmailPayloadHash(payload),
    target: payload.to,
    approvedAt: new Date("2026-09-30T09:00:00Z"),
    approvedBy: userId,
  });

beforeEach(() => {
  for (const name of FLAGS) delete process.env[name];
  process.env.IMAP_SEND_ENABLED = "true";
  vi.clearAllMocks();
  // The reply source is a Naver message; the dispatch lookup and the account
  // lookup both resolve to the same Naver row.
  h.emailFindFirst.mockResolvedValue({ linkedInboxAccountId: "row-1" });
  h.linkedFindFirst.mockImplementation(async (query: { select?: Record<string, boolean> }) =>
    query.select && "provider" in query.select ? { provider: "NAVER" } : NAVER_ROW,
  );
  h.createTransport.mockReturnValue({ sendMail: h.sendMail, close: vi.fn() });
  h.sendMail.mockResolvedValue({ accepted: ["alice@example.com"], rejected: [] });
  h.connect.mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const name of FLAGS) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("send_email to a Naver-bound message — the floor holds", () => {
  it("refuses without a receipt, before any SMTP or IMAP work", async () => {
    await expect(executeToolCall(userId, "send_email", args)).rejects.toBeInstanceOf(
      FloorReceiptRequiredError,
    );
    expect(h.createTransport).not.toHaveBeenCalled();
    expect(h.sendMail).not.toHaveBeenCalled();
    expect(h.imapCtor).not.toHaveBeenCalled();
    expect(h.linkedFindFirst).not.toHaveBeenCalled();
  });

  it("refuses with an explicit null receipt", async () => {
    await expect(executeToolCall(userId, "send_email", args, null)).rejects.toBeInstanceOf(
      FloorReceiptRequiredError,
    );
    expect(h.sendMail).not.toHaveBeenCalled();
  });

  it("refuses the same way for a Gmail-bound message (the refusal does not depend on the provider)", async () => {
    h.emailFindFirst.mockResolvedValue({ linkedInboxAccountId: null });
    await expect(
      executeToolCall(userId, "send_email", { ...args, in_reply_to_email_id: undefined }),
    ).rejects.toBeInstanceOf(FloorReceiptRequiredError);
  });

  it("refuses when the receipt was minted for different bytes", async () => {
    const stale = receiptFor({ ...PAYLOAD, body: "Sounds good!" });
    await expect(executeToolCall(userId, "send_email", args, stale)).rejects.toBeInstanceOf(
      ActionReceiptMismatchError,
    );
    expect(h.createTransport).not.toHaveBeenCalled();
    expect(h.sendMail).not.toHaveBeenCalled();
  });

  it("with a matching receipt and the flag ON, reaches SMTP through the linked Naver account", async () => {
    const result = await executeToolCall(userId, "send_email", args, receiptFor(PAYLOAD));
    expect(JSON.parse(result)).toMatchObject({ success: true });
    expect(h.createTransport).toHaveBeenCalledTimes(1);
    expect(h.createTransport.mock.calls[0][0]).toMatchObject({
      host: "smtp.naver.com",
      auth: { user: "me@naver.com" },
    });
    expect(h.sendMail.mock.calls[0][0].envelope).toEqual({
      from: "me@naver.com",
      to: ["alice@example.com"],
    });
  });

  it("with a matching receipt and the flag OFF, the provider answers unsupported and nothing connects", async () => {
    delete process.env.IMAP_SEND_ENABLED;
    const result = await executeToolCall(userId, "send_email", args, receiptFor(PAYLOAD));
    expect(JSON.parse(result)).toMatchObject({ unsupported: true });
    expect(h.createTransport).not.toHaveBeenCalled();
    expect(h.imapCtor).not.toHaveBeenCalled();
  });
});
