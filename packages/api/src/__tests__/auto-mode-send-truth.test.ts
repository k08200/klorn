/**
 * Auto-mode sweep × the REAL sendAutoReplyViaFloor (only the executor is
 * faked). Pins the truth contract the sweep header promises (#4): a reply that
 * did not leave is never recorded as "Klorn replied for you" and never removes
 * the item from the user's queue. The sweep's own ordering tests fake `send`
 * wholesale, which is how a send that RETURNED a failure result (instead of
 * throwing) slipped past them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const executeToolCall = vi.fn(async (..._args: unknown[]) => "");
vi.mock("../agentcore/tool-executor.js", () => ({
  executeToolCall: (...args: unknown[]) => executeToolCall(...args),
}));

const { runAutoModeSweep, resetAutoModeDraftAttempts } = await import(
  "../agentcore/auto-mode-sweep.js"
);
const { AutoReplyNotSentError, isSingleRecipient, sendAutoReplyViaFloor } = await import(
  "../agentcore/auto-reply-send.js"
);

import type { AutoModeSweepDeps } from "../agentcore/auto-mode-sweep.js";

function makeDeps() {
  const calls: string[] = [];
  const reported: unknown[] = [];
  const deps: AutoModeSweepDeps = {
    findCandidates: async () => [{ id: "item-1", sourceId: "row-1" }],
    findEmail: async () => ({
      id: "row-1",
      gmailId: "g-1",
      from: "Jane <jane@example.com>",
      subject: "Hello",
      body: "hi",
    }),
    alreadyReplied: async () => false,
    isSingleRecipient,
    draftReply: async () => "a fine reply",
    emailStillExists: async () => true,
    writeLedger: async () => {
      calls.push("writeLedger");
      return { id: "ledger-1" };
    },
    // The production wiring (automation-scheduler): the REAL floor send.
    send: (userId, toAddr, subject, body, inReplyToEmailId) => {
      calls.push("send");
      return sendAutoReplyViaFloor(userId, toAddr, subject, body, inReplyToEmailId);
    },
    markLedgerFailed: async (ledgerId) => {
      calls.push(`markLedgerFailed:${ledgerId}`);
    },
    resolveItem: async (itemId) => {
      calls.push(`resolveItem:${itemId}`);
    },
    warn: () => {},
    reportError: (err) => {
      reported.push(err);
    },
    now: () => 1_755_500_000_000,
  };
  return { deps, calls, reported };
}

beforeEach(() => {
  executeToolCall.mockReset();
  resetAutoModeDraftAttempts();
});

describe("auto-mode sweep with the real floor send", () => {
  it("executor returns { error } -> ledger rewritten as failed, item stays OPEN, error reported", async () => {
    executeToolCall.mockResolvedValueOnce(JSON.stringify({ error: "Gmail not connected." }));
    const { deps, calls, reported } = makeDeps();

    await runAutoModeSweep("u1", "guideline", deps);

    expect(calls).toEqual(["writeLedger", "send", "markLedgerFailed:ledger-1"]);
    expect(calls.some((c) => c.startsWith("resolveItem"))).toBe(false);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toBeInstanceOf(AutoReplyNotSentError);
  });

  it("executor returns { unsupported: true, error } -> same: failed ledger, item OPEN, error reported", async () => {
    executeToolCall.mockResolvedValueOnce(
      JSON.stringify({
        unsupported: true,
        error: "This mailbox's provider does not support sending mail from Klorn yet.",
      }),
    );
    const { deps, calls, reported } = makeDeps();

    await runAutoModeSweep("u1", "guideline", deps);

    expect(calls).toEqual(["writeLedger", "send", "markLedgerFailed:ledger-1"]);
    expect(calls.some((c) => c.startsWith("resolveItem"))).toBe(false);
    expect(reported[0]).toBeInstanceOf(AutoReplyNotSentError);
    expect((reported[0] as { reason: string }).reason).toBe("unsupported");
  });

  it("executor folds a thrown provider error into { error } -> still not recorded as sent", async () => {
    // tool-executor's catch turns any non-floor throw into { error: message }.
    executeToolCall.mockResolvedValueOnce(JSON.stringify({ error: "socket hang up" }));
    const { deps, calls } = makeDeps();

    await runAutoModeSweep("u1", "guideline", deps);

    expect(calls).toContain("markLedgerFailed:ledger-1");
    expect(calls.some((c) => c.startsWith("resolveItem"))).toBe(false);
  });

  it("executor returns success -> item resolved as before, ledger untouched, nothing reported", async () => {
    executeToolCall.mockResolvedValueOnce(
      JSON.stringify({ success: true, messageId: "m-1", threadId: "t-1" }),
    );
    const { deps, calls, reported } = makeDeps();

    await runAutoModeSweep("u1", "guideline", deps);

    expect(calls).toEqual(["writeLedger", "send", "resolveItem:item-1"]);
    expect(reported).toHaveLength(0);
  });
});
