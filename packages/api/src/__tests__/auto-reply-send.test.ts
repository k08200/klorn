import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendEmailPayloadHash } from "../judge/attention-floor.js";

// Capture executeToolCall calls; the helper must route the send through it
// (the single gated floor path) instead of calling gmail.sendEmail directly.
// Default = the send_email SUCCESS arm of the provider result union.
const SENT = JSON.stringify({ success: true, messageId: "m-1", threadId: "t-1" });
const executeToolCall = vi.fn(async (..._args: unknown[]) => SENT);
vi.mock("../agentcore/tool-executor.js", () => ({
  executeToolCall: (...args: unknown[]) => executeToolCall(...args),
}));

const { AutoReplyNotSentError, sendAutoReplyViaFloor } = await import(
  "../agentcore/auto-reply-send.js"
);

describe("sendAutoReplyViaFloor — autonomous AUTO_REPLY routes through the floor (W1)", () => {
  beforeEach(() => {
    executeToolCall.mockReset();
    executeToolCall.mockImplementation(async () => SENT);
  });

  it("sends via executeToolCall(send_email) with a receipt that binds the exact bytes", async () => {
    const to = "Bob@Example.com ";
    const subject = "Re: Lunch?";
    const body = "Sure — see you at noon.";
    const trimmed = "Bob@Example.com";

    await sendAutoReplyViaFloor("user-1", to, subject, body);

    expect(executeToolCall).toHaveBeenCalledTimes(1);
    const [userId, tool, args, receipt] = executeToolCall.mock.calls[0] as [
      string,
      string,
      Record<string, string>,
      { action: string; payloadHash: string; target: string; approvedBy: string },
    ];
    expect(userId).toBe("user-1");
    expect(tool).toBe("send_email");
    expect(args).toEqual({ to: trimmed, subject, body });
    // The minted receipt must hash the SAME bytes the executor will re-hash,
    // otherwise the floor's verifyReceipt would refuse the send.
    expect(receipt.action).toBe("send_email");
    expect(receipt.payloadHash).toBe(sendEmailPayloadHash({ to: trimmed, subject, body }));
    expect(receipt.target).toBe("bob@example.com");
    expect(receipt.approvedBy).toBe("user-1");
  });

  it("threads in_reply_to_email_id through to the executor for per-account routing, without touching the hashed bytes", async () => {
    await sendAutoReplyViaFloor("user-1", "bob@example.com", "Re: x", "hi", "email-42");

    const [, , args, receipt] = executeToolCall.mock.calls[0] as [
      string,
      string,
      Record<string, string>,
      { payloadHash: string },
    ];
    // The executor resolves the source row server-side and sends from THAT
    // account (tool-executor's send_email case) — the id is routing metadata.
    expect(args).toEqual({
      to: "bob@example.com",
      subject: "Re: x",
      body: "hi",
      in_reply_to_email_id: "email-42",
    });
    // Routing must not change the receipt: the floor hashes {to,subject,body}.
    expect(receipt.payloadHash).toBe(
      sendEmailPayloadHash({ to: "bob@example.com", subject: "Re: x", body: "hi" }),
    );
  });

  it("refuses a multi-recipient / crafted address and never sends", async () => {
    await expect(
      sendAutoReplyViaFloor("user-1", "victim@real.com, attacker@evil.com", "Re: x", "hi"),
    ).rejects.toThrow(/single valid address/);
    expect(executeToolCall).not.toHaveBeenCalled();
  });
});

// executeToolCall's send_email case does NOT throw on a provider failure: it
// resolves with JSON.stringify(result) where result is the SendMailResult
// union — { success: true, … } | { error } | { unsupported: true, error }
// (a thrown provider error is also folded into { error } by the executor's
// catch). The helper must turn every non-success into a rejection so a caller
// can never record a reply that did not leave.
describe("sendAutoReplyViaFloor — only a proven send resolves", () => {
  beforeEach(() => {
    executeToolCall.mockReset();
  });

  async function sendWithResult(raw: string) {
    executeToolCall.mockResolvedValueOnce(raw);
    return sendAutoReplyViaFloor("user-1", "bob@example.com", "Re: x", "hi", "email-42");
  }

  it("resolves when the executor reports { success: true }", async () => {
    await expect(sendWithResult(SENT)).resolves.toBeUndefined();
  });

  it("rejects with AutoReplyNotSentError when the executor returns { error }", async () => {
    const err = await sendWithResult(JSON.stringify({ error: "Gmail not connected." })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AutoReplyNotSentError);
    expect((err as InstanceType<typeof AutoReplyNotSentError>).reason).toBe("error");
    expect((err as Error).message).toContain("Gmail not connected.");
  });

  it("rejects with reason 'unsupported' for { unsupported: true, error } (NAVER/iCloud row)", async () => {
    const err = await sendWithResult(
      JSON.stringify({
        unsupported: true,
        error: "This mailbox's provider does not support sending mail from Klorn yet.",
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AutoReplyNotSentError);
    expect((err as InstanceType<typeof AutoReplyNotSentError>).reason).toBe("unsupported");
  });

  it("treats unsupported as a failure even if it is (wrongly) paired with success: true", async () => {
    await expect(
      sendWithResult(JSON.stringify({ success: true, unsupported: true, error: "x" })),
    ).rejects.toBeInstanceOf(AutoReplyNotSentError);
  });

  it("treats error as a failure even if it is (wrongly) paired with success: true", async () => {
    await expect(
      sendWithResult(JSON.stringify({ success: true, error: "partial" })),
    ).rejects.toBeInstanceOf(AutoReplyNotSentError);
  });

  it.each([
    ["non-JSON text", "not json at all"],
    ["an empty string", ""],
    ["a JSON array", "[]"],
    ["JSON null", "null"],
    ["a JSON string", JSON.stringify("sent")],
    ["an object without success", JSON.stringify({ ok: true })],
    ["success: false", JSON.stringify({ success: false })],
    ["success as a truthy string", JSON.stringify({ success: "true" })],
    ["the truncation wrapper", JSON.stringify({ truncated: true, content: "{" })],
  ])("fails closed on %s — an unproven send is never a sent reply", async (_label, raw) => {
    const err = await sendWithResult(raw).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AutoReplyNotSentError);
    expect((err as InstanceType<typeof AutoReplyNotSentError>).reason).toBe("unrecognized");
  });

  it("lets a floor refusal thrown by the executor propagate unchanged", async () => {
    const floor = new Error("floor refused");
    executeToolCall.mockRejectedValueOnce(floor);
    await expect(sendAutoReplyViaFloor("user-1", "bob@example.com", "Re: x", "hi")).rejects.toBe(
      floor,
    );
  });
});
