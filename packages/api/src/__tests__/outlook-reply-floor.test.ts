/**
 * Step B0b leaves the deterministic floor exactly where it was. `send_email` on the
 * agent/chat path needs a verified ActionReceipt whatever mailbox it is bound for,
 * and the receipt hash covers {to, subject, body} only (RECEIPT_SCHEMA_VERSION is
 * still "v1").
 *
 * Because the hash does not cover the thread, the agent path must not carry reply
 * context: `in_reply_to_email_id` still only picks the ACCOUNT (as before B0b), and
 * an Outlook send from the agent is the plain sendMail, never the native reply.
 * Making the agent path thread means agent-supplied reply context, and the A4 rule in
 * docs/providers/unified-platform-plan.md then requires the resolved ids in the hash
 * and a RECEIPT_SCHEMA_VERSION bump. If that ever happens, this file must change with it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActionReceiptMismatchError,
  mintReceipt,
  RECEIPT_SCHEMA_VERSION,
  sendEmailPayloadHash,
} from "../judge/attention-floor.js";

const h = vi.hoisted(() => ({
  emailFindFirst: vi.fn(),
  linkedFindFirst: vi.fn(),
  resolveOutlookBearer: vi.fn(),
}));

vi.mock("../mail/outlook-token.js", () => ({ resolveOutlookBearer: h.resolveOutlookBearer }));
vi.mock("../mail/gmail.js", () => ({
  GMAIL_TOOLS: [],
  sendEmail: vi.fn(),
  listEmails: vi.fn(),
  readEmail: vi.fn(),
  markAsRead: vi.fn(),
  classifyEmails: vi.fn(),
  markLinkedInboxForReconnect: vi.fn(),
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
vi.mock("../judge/attention-mirror.js", () => ({ upsertAttentionForCalendarEvent: vi.fn() }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../agentcore/agent-mode.js", () => ({ AGENT_MODES: [] }));
vi.mock("../billing/stripe.js", () => ({ planHasFeature: () => true, TOOL_FEATURE_MAP: {} }));
vi.mock("../agentcore/tool-result-budget.js", () => ({ capToolResult: (s: string) => s }));
vi.mock("../untrusted.js", () => ({ wrapUntrusted: (s: string) => s }));
vi.mock("../utilities.js", () => ({
  UTILITY_TOOLS: [],
  calculate: vi.fn(),
  convertCurrency: vi.fn(),
  generatePassword: vi.fn(),
  shortenUrl: vi.fn(),
  translate: vi.fn(),
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

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

const receiptFor = (payload: { to: string; subject: string; body: string }) =>
  mintReceipt({
    action: "send_email",
    inputHash: "",
    payloadHash: sendEmailPayloadHash(payload),
    target: payload.to,
    approvedAt: new Date("2026-09-30T09:00:00Z"),
    approvedBy: userId,
  });

const graphPaths = () =>
  fetchMock.mock.calls.map((call) => String(call[0]).replace(/^.*\/v1\.0/, ""));

beforeEach(() => {
  vi.clearAllMocks();
  h.emailFindFirst.mockResolvedValue({ linkedInboxAccountId: "row-outlook" });
  h.linkedFindFirst.mockResolvedValue({ provider: "OUTLOOK" });
  h.resolveOutlookBearer.mockResolvedValue({ accessToken: "at", email: "me@outlook.com" });
  fetchMock.mockResolvedValue({ ok: true, status: 202, json: async () => null });
});

describe("send_email to an Outlook-bound message — the floor holds", () => {
  it("still hashes {to, subject, body} under schema v1", () => {
    expect(RECEIPT_SCHEMA_VERSION).toBe("v1");
    expect(sendEmailPayloadHash(PAYLOAD)).toBe(
      sendEmailPayloadHash({ ...PAYLOAD, to: " ALICE@example.com " }),
    );
  });

  it("refuses without a receipt, before any Graph work", async () => {
    await expect(executeToolCall(userId, "send_email", args)).rejects.toBeInstanceOf(
      FloorReceiptRequiredError,
    );
    await expect(executeToolCall(userId, "send_email", args, null)).rejects.toBeInstanceOf(
      FloorReceiptRequiredError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.resolveOutlookBearer).not.toHaveBeenCalled();
  });

  it("refuses a receipt minted for different bytes, before any Graph work", async () => {
    const stale = receiptFor({ ...PAYLOAD, body: "Sounds good!" });
    await expect(executeToolCall(userId, "send_email", args, stale)).rejects.toBeInstanceOf(
      ActionReceiptMismatchError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("with a matching receipt sends the approved bytes as one plain sendMail from the row's account", async () => {
    const result = await executeToolCall(userId, "send_email", args, receiptFor(PAYLOAD));
    expect(JSON.parse(result)).toMatchObject({ success: true });
    expect(graphPaths()).toEqual(["/me/sendMail"]);
    expect(h.resolveOutlookBearer).toHaveBeenCalledWith(userId, "row-outlook");
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual({
      message: {
        subject: "Re: Q3 plan",
        body: { contentType: "Text", content: "Sounds good." },
        toRecipients: [{ emailAddress: { address: "alice@example.com" } }],
      },
      saveToSentItems: true,
    });
  });

  it("never turns the agent's in_reply_to_email_id into a reply target: the receipt does not cover it", async () => {
    // The same approved bytes are accepted whatever id the agent supplies, which is
    // exactly why the id may only choose the account and must not choose a thread.
    for (const id of ["email-42", "email-other", "outlook:me@outlook.com:SOMEONE-ELSES"]) {
      await executeToolCall(
        userId,
        "send_email",
        { ...args, in_reply_to_email_id: id },
        receiptFor(PAYLOAD),
      );
    }
    expect(graphPaths()).toEqual(["/me/sendMail", "/me/sendMail", "/me/sendMail"]);
    expect(graphPaths().join(" ")).not.toMatch(/createReply|\/reply/);
  });
});
