import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendEmailPayloadHash } from "../attention-floor.js";

// Capture executeToolCall calls; the helper must route the send through it
// (the single gated floor path) instead of calling gmail.sendEmail directly.
const executeToolCall = vi.fn(async () => JSON.stringify({ ok: true }));
vi.mock("../agentcore/tool-executor.js", () => ({
  executeToolCall: (...args: unknown[]) => executeToolCall(...args),
}));

const { sendAutoReplyViaFloor } = await import("../agentcore/auto-reply-send.js");

describe("sendAutoReplyViaFloor — autonomous AUTO_REPLY routes through the floor (W1)", () => {
  beforeEach(() => executeToolCall.mockClear());

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

  it("refuses a multi-recipient / crafted address and never sends", async () => {
    await expect(
      sendAutoReplyViaFloor("user-1", "victim@real.com, attacker@evil.com", "Re: x", "hi"),
    ).rejects.toThrow(/single valid address/);
    expect(executeToolCall).not.toHaveBeenCalled();
  });
});
