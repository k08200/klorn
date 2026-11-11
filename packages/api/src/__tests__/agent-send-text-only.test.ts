/**
 * Tripwire for #1276: the agent send path is text-only.
 *
 * `sendEmailPayloadHash` binds a send receipt to `{to, subject, body}` and
 * nothing else. SECURITY.md C5 ("approval binds bytes") therefore holds for
 * agent sends only because those sends carry no attachments. If the
 * `send_email` tool ever offers the model an attachment field, or the
 * executor ever hands the provider a non-empty attachment list, a file could
 * be swapped between approval and execution and the receipt would still
 * verify.
 *
 * These tests fail at that moment. Do not loosen them on their own: land
 * #1276 first (per-attachment sha256 digests join the canonical hash, the
 * receipt schema version bumps, attention-floor.test.ts gains "flips when an
 * attachment changes"), then widen them.
 */

import { describe, expect, it, vi } from "vitest";
import { mintReceipt, sendEmailPayloadHash } from "../judge/attention-floor.js";

const TRIPWIRE =
  "The agent send path must stay text-only until attachment digests join sendEmailPayloadHash — see #1276";

const sendEmailMock = vi.fn(async (..._args: unknown[]) => ({
  success: true,
  messageId: "msg-1",
}));

// Keep the real GMAIL_TOOLS (the schema under test reaches the model through
// ALL_TOOLS); replace only the network send.
vi.mock("../mail/gmail.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mail/gmail.js")>()),
  sendEmail: (...args: unknown[]) => sendEmailMock(...args),
}));
vi.mock("../mail/sent-messages.js", () => ({ recordSentMessage: vi.fn(async () => {}) }));
vi.mock("../db.js", () => ({
  prisma: {
    emailMessage: { findFirst: async () => null },
    linkedInboxAccount: { findFirst: async () => ({ provider: "GOOGLE" }) },
  },
  db: {},
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const { ALL_TOOLS, executeToolCall } = await import("../agentcore/tool-executor.js");

/** Every field the model may set on send_email. `in_reply_to_email_id` only
 * routes the send to the right inbox; it is not content and is not hashed. */
const TEXT_ONLY_SEND_FIELDS = ["body", "in_reply_to_email_id", "subject", "to"];

describe("agent send path is text-only (#1276)", () => {
  it("offers the model a send_email tool with text fields only", () => {
    const sendTools = ALL_TOOLS.filter((tool) => tool.function.name === "send_email");
    expect(sendTools, "exactly one send_email definition reaches the model").toHaveLength(1);

    const parameters = sendTools[0].function.parameters as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(parameters.properties).sort(), TRIPWIRE).toEqual(TEXT_ONLY_SEND_FIELDS);
  });

  it("hands the provider an empty attachment list even when the tool call carries one", async () => {
    const args = { to: "alice@example.com", subject: "Re: Q3 plan", body: "Attached." };
    const receipt = mintReceipt({
      action: "send_email",
      inputHash: "",
      payloadHash: sendEmailPayloadHash(args),
      target: args.to,
      approvedAt: new Date("2026-11-11T00:00:00Z"),
      approvedBy: "user-1",
    });

    const smuggled = {
      ...args,
      attachments: [
        { filename: "invoice.pdf", mimeType: "application/pdf", content: "JVBERi0xLjQ=" },
      ],
    };
    const result = await executeToolCall("user-1", "send_email", smuggled, receipt);

    expect(JSON.parse(result)).toMatchObject({ success: true });
    expect(sendEmailMock).toHaveBeenCalledOnce();
    const [, to, subject, body, attachments] = sendEmailMock.mock.calls[0];
    expect([to, subject, body]).toEqual([args.to, args.subject, args.body]);
    expect(attachments, TRIPWIRE).toEqual([]);
  });
});
