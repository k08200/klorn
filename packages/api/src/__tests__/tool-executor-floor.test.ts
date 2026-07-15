/**
 * Floor enforcement at the tool-executor seam.
 *
 * Locks down the property the doctrine depends on: a floor action
 * (`send_email`) cannot reach its side-effect path without a verified
 * ActionReceipt. The receipt's payloadHash must match a fresh hash of
 * the about-to-execute bytes; mismatch throws and refuses execution.
 *
 * The Gmail send call is mocked so this stays a unit test (no token,
 * no network). The assertion is on the floor — does executeToolCall
 * refuse / pass through correctly given the receipt state?
 */

import { describe, expect, it, vi } from "vitest";
import { mintReceipt, RECEIPT_SCHEMA_VERSION, sendEmailPayloadHash } from "../attention-floor.js";

// Mock everything tool-executor pulls in that would touch external state.
// We only care about the floor guard at the send_email seam.
const sendEmailMock = vi.fn(async () => ({ success: true, messageId: "msg-1" }));
// Source-email lookup send_email uses to resolve the linked inbox account.
const findFirstMock = vi.fn(
  async (): Promise<{ linkedInboxAccountId: string | null } | null> => null,
);

vi.mock("../gmail.js", () => ({
  GMAIL_TOOLS: [],
  sendEmail: (...args: unknown[]) => sendEmailMock(...args),
  listEmails: vi.fn(),
  readEmail: vi.fn(),
  markAsRead: vi.fn(),
  classifyEmails: vi.fn(),
}));
vi.mock("../db.js", () => ({
  prisma: { emailMessage: { findFirst: (...args: unknown[]) => findFirstMock(...args) } },
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
vi.mock("../search.js", () => ({ SEARCH_TOOLS: [], webSearch: vi.fn() }));
vi.mock("../skill-executor.js", () => ({
  SKILL_TOOLS: [],
  executeSkill: vi.fn(),
  listUserSkills: vi.fn(),
}));
vi.mock("../skill-recorder.js", () => ({ recordSkill: vi.fn() }));
vi.mock("../attention-mirror.js", () => ({
  upsertAttentionForCalendarEvent: vi.fn(),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../agent-mode.js", () => ({ AGENT_MODES: [] }));
vi.mock("../billing/stripe.js", () => ({
  planHasFeature: () => true,
  TOOL_FEATURE_MAP: {},
}));
vi.mock("../tool-result-budget.js", () => ({
  capToolResult: (s: string) => s,
}));
vi.mock("../untrusted.js", () => ({
  wrapUntrusted: (s: string) => s,
}));
vi.mock("../utilities.js", () => ({
  UTILITY_TOOLS: [],
  calculate: vi.fn(),
  convertCurrency: vi.fn(),
  generatePassword: vi.fn(),
  shortenUrl: vi.fn(),
  translate: vi.fn(),
}));

const { executeToolCall, FloorReceiptRequiredError } = await import("../tool-executor.js");
const { ActionReceiptMismatchError } = await import("../attention-floor.js");

const userId = "user-1";

describe("executeToolCall — floor enforcement for send_email", () => {
  const args = {
    to: "alice@example.com",
    subject: "Re: Q3 plan",
    body: "Sounds good.",
  };

  it("refuses with FloorReceiptRequiredError when no receipt is provided", async () => {
    await expect(executeToolCall(userId, "send_email", args)).rejects.toBeInstanceOf(
      FloorReceiptRequiredError,
    );
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("refuses with FloorReceiptRequiredError when receipt is explicitly null", async () => {
    await expect(executeToolCall(userId, "send_email", args, null)).rejects.toBeInstanceOf(
      FloorReceiptRequiredError,
    );
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("executes when the receipt matches the payload exactly", async () => {
    sendEmailMock.mockClear();
    const payloadHash = sendEmailPayloadHash(args);
    const receipt = mintReceipt({
      action: "send_email",
      inputHash: "",
      payloadHash,
      target: args.to,
      approvedAt: new Date("2026-06-04T09:00:00Z"),
      approvedBy: userId,
    });
    const result = await executeToolCall(userId, "send_email", args, receipt);
    expect(JSON.parse(result)).toMatchObject({ success: true });
    expect(sendEmailMock).toHaveBeenCalledOnce();
    // No in_reply_to_email_id → no source lookup → primary account (undefined).
    expect(sendEmailMock).toHaveBeenCalledWith(userId, args.to, args.subject, args.body, [], {
      linkedInboxAccountId: undefined,
    });
  });

  it("routes the send through the linked inbox when in_reply_to_email_id resolves to one", async () => {
    sendEmailMock.mockClear();
    findFirstMock.mockClear();
    findFirstMock.mockResolvedValueOnce({ linkedInboxAccountId: "linked-abc" });
    // The routing arg is NOT part of the payload hash — the receipt still
    // verifies over {to,subject,body}, so the floor is unaffected.
    const receipt = mintReceipt({
      action: "send_email",
      inputHash: "",
      payloadHash: sendEmailPayloadHash(args),
      target: args.to,
      approvedAt: new Date("2026-06-04T09:00:00Z"),
      approvedBy: userId,
    });
    const result = await executeToolCall(
      userId,
      "send_email",
      { ...args, in_reply_to_email_id: "email-42" },
      receipt,
    );
    expect(JSON.parse(result)).toMatchObject({ success: true });
    expect(findFirstMock).toHaveBeenCalledOnce();
    expect(sendEmailMock).toHaveBeenCalledWith(userId, args.to, args.subject, args.body, [], {
      linkedInboxAccountId: "linked-abc",
    });
  });

  it("falls back to the primary account when in_reply_to_email_id resolves to nothing", async () => {
    sendEmailMock.mockClear();
    findFirstMock.mockClear();
    findFirstMock.mockResolvedValueOnce(null); // stale / foreign id → no row
    const receipt = mintReceipt({
      action: "send_email",
      inputHash: "",
      payloadHash: sendEmailPayloadHash(args),
      target: args.to,
      approvedAt: new Date("2026-06-04T09:00:00Z"),
      approvedBy: userId,
    });
    await executeToolCall(
      userId,
      "send_email",
      { ...args, in_reply_to_email_id: "does-not-exist" },
      receipt,
    );
    expect(sendEmailMock).toHaveBeenCalledWith(userId, args.to, args.subject, args.body, [], {
      linkedInboxAccountId: undefined,
    });
  });

  it("throws ActionReceiptMismatchError when the body has been mutated post-approve", async () => {
    sendEmailMock.mockClear();
    // Receipt was minted for "Sounds good." but executor is asked to send
    // a single-character mutation. The verify must catch this.
    const approvedHash = sendEmailPayloadHash(args);
    const receipt = mintReceipt({
      action: "send_email",
      inputHash: "",
      payloadHash: approvedHash,
      target: args.to,
      approvedAt: new Date("2026-06-04T09:00:00Z"),
      approvedBy: userId,
    });
    const mutated = { ...args, body: "Sounds good!" };
    await expect(executeToolCall(userId, "send_email", mutated, receipt)).rejects.toBeInstanceOf(
      ActionReceiptMismatchError,
    );
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("throws ActionReceiptMismatchError when receipt is for a different action class", async () => {
    sendEmailMock.mockClear();
    // delete_permanent receipt cannot authorize send_email. verifyReceipt
    // catches the action mismatch even when payloadHash happens to align
    // (which it wouldn't here, but the action check fires first).
    const receipt = mintReceipt({
      action: "delete_permanent",
      inputHash: "",
      payloadHash: "a".repeat(64),
      target: "msg-1",
      approvedAt: new Date("2026-06-04T09:00:00Z"),
      approvedBy: userId,
    });
    await expect(executeToolCall(userId, "send_email", args, receipt)).rejects.toBeInstanceOf(
      ActionReceiptMismatchError,
    );
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe("executeToolCall — central floor guard covers every FLOOR_ACTION", () => {
  // The doctrine names three floor actions. send_email is the only one wired
  // as a callable tool today, but the guard must fail closed for the other
  // two as well — so adding their tool case later cannot ship a path that
  // side-steps the receipt. Without the central guard these names fall through
  // to the default branch and return {error: "Unknown function"} instead of
  // refusing, which is the silent bypass the floor exists to prevent.
  it("refuses delete_permanent without a receipt (fail-closed before the switch)", async () => {
    await expect(
      executeToolCall(userId, "delete_permanent", { gmailId: "msg-1" }),
    ).rejects.toBeInstanceOf(FloorReceiptRequiredError);
  });

  it("refuses forward_external without a receipt", async () => {
    await expect(
      executeToolCall(userId, "forward_external", { gmailId: "msg-1", to: "x@y.com" }),
    ).rejects.toBeInstanceOf(FloorReceiptRequiredError);
  });
});

describe("executeToolCall — non-floor tools ignore receipt requirements", () => {
  it("schema version is wired through the receipt — sanity check", () => {
    // If this fails, the receipt format has drifted and existing pending
    // approvals need re-approve. Catch it loud, not on prod.
    expect(RECEIPT_SCHEMA_VERSION).toBe("v1");
  });
});
