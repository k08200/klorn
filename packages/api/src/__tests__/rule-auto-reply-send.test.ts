/**
 * AUTO_REPLY rule sweep (automation-scheduler) x the REAL sendAutoReplyViaFloor,
 * over a stateful fake Notification table with the real (userId, dedupeKey)
 * unique. The ledger contract mirrors auto-mode:
 *   - a row keyed `auto-reply:<gmailId>` is claimed BEFORE the send; a P2002
 *     loser never sends,
 *   - a failed send rewrites the row as a failure record but KEEPS the key, so
 *     no later tick re-sends (Gmail can accept a send while the client sees an
 *     error — a retry could double-reply),
 *   - "Auto-reply sent" is written only after a send the provider accepted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const executeToolCall = vi.fn(async (..._args: unknown[]) => "");
vi.mock("../agentcore/tool-executor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agentcore/tool-executor.js")>()),
  executeToolCall: (...args: unknown[]) => executeToolCall(...args),
}));

interface Row {
  id: string;
  userId: string;
  type: string;
  dedupeKey: string | null;
  title: string;
  message: string;
  createdAt: Date;
}
type Where = Record<string, unknown>;

const store = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  seq: 0,
  updateFails: false,
  log: [] as string[],
}));

class MockPrismaError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function matches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Where[]).some((w) => matches(row, w));
    if (cond && typeof cond === "object") {
      const c = cond as { in?: unknown[]; contains?: string };
      if (c.in) return c.in.includes(row[key]);
      if (c.contains !== undefined) {
        return typeof row[key] === "string" && (row[key] as string).includes(c.contains);
      }
    }
    return row[key] === cond;
  });
}

vi.mock("../db.js", () => ({
  prisma: {
    notification: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        store.log.push("notification.create");
        if (
          data.dedupeKey &&
          store.rows.some((r) => r.userId === data.userId && r.dedupeKey === data.dedupeKey)
        ) {
          throw new MockPrismaError("P2002");
        }
        const row = { id: `n-${++store.seq}`, createdAt: new Date(), ...data };
        store.rows.push(row);
        return row;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          store.log.push("notification.update");
          if (store.updateFails) throw new Error("db down");
          const i = store.rows.findIndex((r) => r.id === where.id);
          store.rows[i] = { ...store.rows[i], ...data };
          return store.rows[i];
        },
      ),
      findFirst: vi.fn(async ({ where }: { where: Where }) => {
        return store.rows.find((r) => matches(r, where)) ?? null;
      }),
    },
  },
}));
vi.mock("../notify/push.js", () => ({ sendPushNotification: vi.fn(() => Promise.resolve()) }));
vi.mock("../websocket.js", () => ({ pushNotification: vi.fn() }));
vi.mock("../sentry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sentry.js")>()),
  captureError: vi.fn(),
}));

import { runAutoModeSweep } from "../agentcore/auto-mode-sweep.js";
import { AutoReplyNotSentError } from "../agentcore/auto-reply-send.js";
import {
  deliverRuleAutoReply,
  ensureAutoModeReplyNotification,
  hasAutoReplyClaim,
  markAutoModeLedgerFailed,
} from "../automation-scheduler.js";
import { prisma } from "../db.js";
import { captureError } from "../sentry.js";
import { pushNotification } from "../websocket.js";

const USER = "u1";
const email = {
  id: "row-1",
  gmailId: "g-1",
  from: "Jane <jane@example.com>",
  subject: "Hello",
};
const SENT = JSON.stringify({ success: true, messageId: "m-1" });

function ledgerRow(): Row {
  const row = store.rows.find((r) => r.dedupeKey === "auto-reply:g-1");
  if (!row) throw new Error("no auto-reply ledger row");
  return row as unknown as Row;
}

beforeEach(() => {
  store.rows = [];
  store.seq = 0;
  store.updateFails = false;
  store.log = [];
  executeToolCall.mockReset();
  executeToolCall.mockImplementation(async () => {
    store.log.push("send");
    return SENT;
  });
  vi.mocked(pushNotification).mockClear();
  vi.mocked(captureError).mockClear();
});

describe("deliverRuleAutoReply — claim, send, then settle the ledger", () => {
  it("claims the auto-reply:<gmailId> row BEFORE the send, then flips it to 'Auto-reply sent' and pushes once", async () => {
    await deliverRuleAutoReply(USER, email, "thanks!", "vip rule");

    expect(store.log).toEqual(["notification.create", "send", "notification.update"]);
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
    expect(ledgerRow().title).toBe("Auto-reply sent");
    expect(ledgerRow().message).toContain("jane@example.com");
    expect(pushNotification).toHaveBeenCalledTimes(1);
  });

  it("the in-flight claim never claims success: it is not titled 'Auto-reply sent' until the send is accepted", async () => {
    let titleDuringSend = "";
    executeToolCall.mockImplementationOnce(async () => {
      titleDuringSend = ledgerRow().title;
      return SENT;
    });

    await deliverRuleAutoReply(USER, email, "thanks!", "vip rule");

    expect(titleDuringSend).not.toBe("Auto-reply sent");
    expect(titleDuringSend.length).toBeGreaterThan(0);
  });

  it.each([
    ["{ error }", { error: "Gmail not connected." }],
    ["{ unsupported: true, error }", { unsupported: true, error: "no send surface" }],
  ])("executor returns %s -> rejects, rewrites the row as a failure that KEEPS the dedupeKey, no success alert", async (_l, result) => {
    executeToolCall.mockResolvedValueOnce(JSON.stringify(result));

    await expect(deliverRuleAutoReply(USER, email, "thanks!", "vip rule")).rejects.toBeInstanceOf(
      AutoReplyNotSentError,
    );

    expect(store.rows).toHaveLength(1);
    expect(ledgerRow().dedupeKey).toBe("auto-reply:g-1");
    expect(ledgerRow().title).toBe("Auto-reply failed");
    expect(ledgerRow().title).not.toBe("Auto-reply sent");
    expect(pushNotification).not.toHaveBeenCalled();
  });

  it("a send that failed after delivery (executor folds the throw into { error }) is NOT retried on a later tick", async () => {
    executeToolCall.mockResolvedValueOnce(JSON.stringify({ error: "socket hang up" }));
    await expect(deliverRuleAutoReply(USER, email, "thanks!", "vip rule")).rejects.toBeInstanceOf(
      AutoReplyNotSentError,
    );

    // Next new-mail tick: the sweep's pre-filter sees the claim...
    expect(await hasAutoReplyClaim(USER, email.gmailId)).toBe(true);
    // ...and even if the email were re-selected, the unique key stops the send.
    await expect(deliverRuleAutoReply(USER, email, "thanks!", "vip rule")).resolves.toBeUndefined();
    expect(executeToolCall).toHaveBeenCalledTimes(1);
  });

  it("a P2002 loser never sends and never pushes", async () => {
    await prisma.notification.create({
      data: { userId: USER, type: "email", dedupeKey: "auto-reply:g-1", title: "x", message: "y" },
    } as never);
    store.log = [];

    await expect(deliverRuleAutoReply(USER, email, "thanks!", "vip rule")).resolves.toBeUndefined();

    expect(executeToolCall).not.toHaveBeenCalled();
    expect(pushNotification).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(1);
  });

  it("refuses a multi-recipient From BEFORE claiming or sending", async () => {
    await expect(
      deliverRuleAutoReply(USER, { ...email, from: "a@x.com, b@evil.com" }, "thanks!", "vip rule"),
    ).rejects.toThrow(/single valid address/);

    expect(store.rows).toHaveLength(0);
    expect(executeToolCall).not.toHaveBeenCalled();
  });

  it("an accepted send whose 'sent' rewrite fails keeps the claim: no failure rewrite, no retry", async () => {
    executeToolCall.mockImplementationOnce(async () => {
      store.log.push("send");
      store.updateFails = true; // the post-send rewrite will throw
      return SENT;
    });

    await expect(deliverRuleAutoReply(USER, email, "thanks!", "vip rule")).rejects.toThrow(
      "db down",
    );

    // The send DID leave: the row must not be rewritten as a failure, and the
    // key still blocks a second send.
    expect(ledgerRow().title).not.toBe("Auto-reply failed");
    store.updateFails = false;
    await deliverRuleAutoReply(USER, email, "thanks!", "vip rule");
    expect(executeToolCall).toHaveBeenCalledTimes(1);
  });

  it("a failed failure-rewrite still surfaces the ORIGINAL send error and reports the rewrite failure", async () => {
    executeToolCall.mockImplementationOnce(async () => {
      store.updateFails = true;
      return JSON.stringify({ error: "Gmail not connected." });
    });

    await expect(deliverRuleAutoReply(USER, email, "thanks!", "vip rule")).rejects.toBeInstanceOf(
      AutoReplyNotSentError,
    );
    expect(captureError).toHaveBeenCalledTimes(1);
  });
});

describe("hasAutoReplyClaim — the one dedupe lookup both sweeps share", () => {
  it("sees a rule claim (auto-reply:) — so auto-mode skips the mail without spending an LLM call", async () => {
    await deliverRuleAutoReply(USER, email, "thanks!", "vip rule");

    const draftReply = vi.fn(async () => "draft");
    await runAutoModeSweep(USER, "guideline", {
      findCandidates: async () => [{ id: "item-1", sourceId: "row-1" }],
      findEmail: async () => ({ ...email, body: "hi" }),
      alreadyReplied: hasAutoReplyClaim, // the production wiring
      isSingleRecipient: () => true,
      draftReply,
      emailStillExists: async () => true,
      writeLedger: async () => ({ id: "l" }),
      send: async () => {},
      markLedgerFailed: async () => {},
      resolveItem: async () => {},
      warn: () => {},
      reportError: () => {},
      now: () => 0,
    });
    expect(draftReply).not.toHaveBeenCalled();
  });

  it("sees an auto-mode ledger (auto-mode-reply:) — the rule sweep's pre-filter then skips the mail", async () => {
    await ensureAutoModeReplyNotification(USER, "g-1", "jane@example.com");

    expect(await hasAutoReplyClaim(USER, "g-1")).toBe(true);
  });

  it("still recognises a legacy 'Auto-reply sent' row that predates the dedupeKey", async () => {
    store.rows.push({
      id: "legacy",
      userId: USER,
      type: "email",
      dedupeKey: null,
      title: "Auto-reply sent",
      message: 'Auto-replied to jane@example.com (rule: "r") [g-legacy]',
      createdAt: new Date(),
    });
    expect(await hasAutoReplyClaim(USER, "g-legacy")).toBe(true);
  });

  it("is scoped to the user and to the gmailId", async () => {
    await ensureAutoModeReplyNotification(USER, "g-1", "jane@example.com");
    expect(await hasAutoReplyClaim("someone-else", "g-1")).toBe(false);
    expect(await hasAutoReplyClaim(USER, "g-other")).toBe(false);
  });
});

describe("markAutoModeLedgerFailed — a failed rewrite leaves 'Klorn replied for you', so it must be reported", () => {
  it("rewrites the ledger as a failure record", async () => {
    const ledger = await ensureAutoModeReplyNotification(USER, "g-1", "jane@example.com");

    await markAutoModeLedgerFailed(ledger?.id ?? "", "jane@example.com", "g-1");

    const row = store.rows[0] as unknown as Row;
    expect(row.title).toBe("Auto-mode reply failed");
    expect(row.dedupeKey).toBe("auto-mode-reply:g-1");
  });

  it("captureErrors (not just warns) when the rewrite itself fails, and does not throw", async () => {
    const ledger = await ensureAutoModeReplyNotification(USER, "g-1", "jane@example.com");
    store.updateFails = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      markAutoModeLedgerFailed(ledger?.id ?? "", "jane@example.com", "g-1"),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    expect(captureError).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
