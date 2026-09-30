/**
 * AUTO_REPLY rule sweep (automation-scheduler) × the REAL sendAutoReplyViaFloor.
 * The "Auto-reply sent" alert is the user-visible claim that a rule reply went
 * out; it must be written only for a send the provider actually accepted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const executeToolCall = vi.fn(async (..._args: unknown[]) => "");
vi.mock("../agentcore/tool-executor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agentcore/tool-executor.js")>()),
  executeToolCall: (...args: unknown[]) => executeToolCall(...args),
}));

vi.mock("../db.js", () => ({
  prisma: {
    notification: {
      create: vi.fn(() => Promise.resolve({ id: "notif-1", createdAt: new Date() })),
    },
  },
}));
vi.mock("../notify/push.js", () => ({ sendPushNotification: vi.fn(() => Promise.resolve()) }));
vi.mock("../websocket.js", () => ({ pushNotification: vi.fn() }));

import { AutoReplyNotSentError } from "../agentcore/auto-reply-send.js";
import { deliverRuleAutoReply } from "../automation-scheduler.js";
import { prisma } from "../db.js";

const email = {
  id: "row-1",
  gmailId: "g-1",
  from: "Jane <jane@example.com>",
  subject: "Hello",
};

beforeEach(() => {
  executeToolCall.mockReset();
  vi.mocked(prisma.notification.create).mockClear();
});

describe("deliverRuleAutoReply — the rule sweep's send + alert", () => {
  it("sends through the floor with the row id for per-account routing, then records the alert", async () => {
    executeToolCall.mockResolvedValueOnce(JSON.stringify({ success: true, messageId: "m-1" }));

    await deliverRuleAutoReply("u1", email, "thanks!", "vip rule");

    expect(executeToolCall).toHaveBeenCalledTimes(1);
    const [, tool, args] = executeToolCall.mock.calls[0] as [
      string,
      string,
      Record<string, string>,
    ];
    expect(tool).toBe("send_email");
    expect(args).toMatchObject({
      to: "jane@example.com",
      subject: "Re: Hello",
      body: "thanks!",
      in_reply_to_email_id: "row-1",
    });
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ dedupeKey: "auto-reply:g-1", title: "Auto-reply sent" }),
      }),
    );
  });

  it.each([
    ["{ error }", { error: "Gmail not connected." }],
    ["{ unsupported: true, error }", { unsupported: true, error: "no send surface" }],
  ])("executor returns %s -> rejects and never writes the 'Auto-reply sent' alert", async (_l, result) => {
    executeToolCall.mockResolvedValueOnce(JSON.stringify(result));

    await expect(deliverRuleAutoReply("u1", email, "thanks!", "vip rule")).rejects.toBeInstanceOf(
      AutoReplyNotSentError,
    );
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });
});
