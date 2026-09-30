/**
 * AUTO_REPLY rule sweep (automation-scheduler) x the REAL sendAutoReplyViaFloor,
 * over a stateful fake Notification table with the real (userId, dedupeKey)
 * unique. The ledger contract mirrors auto-mode:
 *   - a row keyed `auto-reply:<gmailId>` is claimed BEFORE the send; a P2002
 *     loser never sends,
 *   - a failed send rewrites the row as a failure record but KEEPS the key, so
 *     no later tick re-sends (Gmail can accept a send while the client sees an
 *     error — a retry could double-reply),
 *   - "Auto-reply sent" is written only after a send the provider accepted,
 *   - ONE key (`auto-reply:`) is the lock for both the rule sweep and auto-mode,
 *   - clearing the bell never deletes a claim.
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
  queries: [] as Array<Record<string, unknown>>,
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
    if (key === "AND") return (cond as Where[]).every((w) => matches(row, w));
    if (key === "NOT") {
      const list = Array.isArray(cond) ? (cond as Where[]) : [cond as Where];
      return list.every((w) => !matches(row, w));
    }
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as {
        in?: unknown[];
        contains?: string;
        startsWith?: string;
        not?: unknown;
      };
      if (c.in) return c.in.includes(row[key]);
      if (c.contains !== undefined) {
        return typeof row[key] === "string" && (row[key] as string).includes(c.contains);
      }
      if (c.startsWith !== undefined) {
        return typeof row[key] === "string" && (row[key] as string).startsWith(c.startsWith);
      }
      if ("not" in c) return row[key] !== c.not;
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
        store.queries.push(where);
        return store.rows.find((r) => matches(r, where)) ?? null;
      }),
      findMany: vi.fn(async ({ where }: { where: Where }) =>
        store.rows.filter((r) => matches(r, where)),
      ),
      deleteMany: vi.fn(async ({ where }: { where: Where }) => {
        const doomed = store.rows.filter((r) => matches(r, where));
        store.rows = store.rows.filter((r) => !doomed.includes(r));
        return { count: doomed.length };
      }),
      updateMany: vi.fn(
        async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
          const hit = store.rows.filter((r) => matches(r, where));
          store.rows = store.rows.map((r) => (hit.includes(r) ? { ...r, ...data } : r));
          return { count: hit.length };
        },
      ),
    },
    attentionItem: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      updateMany: vi.fn(async () => ({ count: 0 })),
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
  claimAutoReplyLedger,
  deliverRuleAutoReply,
  ensureAutoModeReplyNotification,
  hasAutoReplyClaim,
  markAutoModeLedgerFailed,
  runRuleAutoReply,
} from "../automation-scheduler.js";
import { clearNotifications, getNotifications } from "../background.js";
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
  store.queries = [];
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

  it("the in-flight claim never claims success and is hidden from the bell until the send settles", async () => {
    let during: Row | undefined;
    let listedDuringSend: unknown[] = [];
    executeToolCall.mockImplementationOnce(async () => {
      during = { ...ledgerRow() };
      listedDuringSend = await getNotifications(USER);
      return SENT;
    });

    await deliverRuleAutoReply(USER, email, "thanks!", "vip rule");

    expect(during?.title).not.toBe("Auto-reply sent");
    expect(during?.type).toBe("claim");
    expect(listedDuringSend).toHaveLength(0);
    // Settled: visible to the bell, so the WS push and the list agree.
    expect(ledgerRow().type).toBe("email");
    expect(await getNotifications(USER)).toHaveLength(1);
  });

  it("executor returns { unsupported: true, error } -> the row says 'Auto-reply failed' (certainly not sent), key kept, visible", async () => {
    executeToolCall.mockResolvedValueOnce(
      JSON.stringify({ unsupported: true, error: "no send surface" }),
    );

    await expect(deliverRuleAutoReply(USER, email, "thanks!", "vip rule")).rejects.toBeInstanceOf(
      AutoReplyNotSentError,
    );

    expect(store.rows).toHaveLength(1);
    expect(ledgerRow().dedupeKey).toBe("auto-reply:g-1");
    expect(ledgerRow().title).toBe("Auto-reply failed");
    expect(ledgerRow().type).toBe("email");
    expect(pushNotification).not.toHaveBeenCalled();
  });

  it.each([
    ["{ error }", JSON.stringify({ error: "Gmail not connected." })],
    ["an unrecognised result", "not json"],
  ])("executor returns %s -> delivery is UNKNOWN: the row says 'not confirmed' and to check Sent, never plain 'failed'", async (_l, raw) => {
    executeToolCall.mockResolvedValueOnce(raw);

    await expect(deliverRuleAutoReply(USER, email, "thanks!", "vip rule")).rejects.toBeInstanceOf(
      AutoReplyNotSentError,
    );

    expect(ledgerRow().dedupeKey).toBe("auto-reply:g-1");
    expect(ledgerRow().title).toBe("Auto-reply not confirmed");
    expect(ledgerRow().title).not.toMatch(/failed|sent$/i);
    expect(ledgerRow().message).toMatch(/Sent folder/);
    expect(ledgerRow().type).toBe("email");
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
    ).rejects.toThrow(/^(?!.*evil\.com).*single valid address/s);

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

  it("still recognises a claim written under the older auto-mode-reply: key", async () => {
    store.rows.push({
      id: "old-auto-mode",
      userId: USER,
      type: "email",
      dedupeKey: "auto-mode-reply:g-1",
      title: "Klorn replied for you",
      message: "Auto-mode replied to jane@example.com [g-1]",
      createdAt: new Date(),
    });

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

  it("matches the legacy marker exactly as [gmailId] — a longer id that merely contains it is not a claim", async () => {
    store.rows.push({
      id: "legacy",
      userId: USER,
      type: "email",
      dedupeKey: null,
      title: "Auto-reply sent",
      message: 'Auto-replied to jane@example.com (rule: "r") [g-10]',
      createdAt: new Date(),
    });
    expect(await hasAutoReplyClaim(USER, "g-1")).toBe(false);
    expect(await hasAutoReplyClaim(USER, "g-10")).toBe(true);
  });

  it("runs the dedupeKey lookup FIRST and skips the legacy scan on a hit", async () => {
    await ensureAutoModeReplyNotification(USER, "g-1", "jane@example.com");
    store.queries = [];

    expect(await hasAutoReplyClaim(USER, "g-1")).toBe(true);

    expect(store.queries).toHaveLength(1);
    expect(store.queries[0]).toMatchObject({ dedupeKey: { in: expect.any(Array) } });
    expect(JSON.stringify(store.queries[0])).not.toContain("contains");
  });

  it("is scoped to the user and to the gmailId", async () => {
    await ensureAutoModeReplyNotification(USER, "g-1", "jane@example.com");
    expect(await hasAutoReplyClaim("someone-else", "g-1")).toBe(false);
    expect(await hasAutoReplyClaim(USER, "g-other")).toBe(false);
  });
});

describe("markAutoModeLedgerFailed — a failed rewrite leaves 'Klorn replied for you', so it must be reported", () => {
  it("the shared claim key is auto-reply:<gmailId> — auto-mode writes the same key the rule sweep does", async () => {
    await ensureAutoModeReplyNotification(USER, "g-1", "jane@example.com");
    expect(store.rows[0]?.dedupeKey).toBe("auto-reply:g-1");
  });

  it("rewrites the ledger keeping the key; { unsupported } is certainly 'failed'", async () => {
    const ledger = await ensureAutoModeReplyNotification(USER, "g-1", "jane@example.com");

    await markAutoModeLedgerFailed(
      ledger?.id ?? "",
      "jane@example.com",
      "g-1",
      new AutoReplyNotSentError("unsupported"),
    );

    const row = store.rows[0] as unknown as Row;
    expect(row.title).toBe("Auto-mode reply failed");
    expect(row.dedupeKey).toBe("auto-reply:g-1");
  });

  it.each([
    "error",
    "unrecognized",
  ] as const)("reason '%s' is delivery-unknown: 'not confirmed', check Sent", async (reason) => {
    const ledger = await ensureAutoModeReplyNotification(USER, "g-1", "jane@example.com");

    await markAutoModeLedgerFailed(
      ledger?.id ?? "",
      "jane@example.com",
      "g-1",
      new AutoReplyNotSentError(reason),
    );

    const row = store.rows[0] as unknown as Row;
    expect(row.title).toBe("Auto-mode reply not confirmed");
    expect(row.message).toMatch(/Sent folder/);
  });

  it("captureErrors (not just warns) when the rewrite itself fails, and does not throw", async () => {
    const ledger = await ensureAutoModeReplyNotification(USER, "g-1", "jane@example.com");
    store.updateFails = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      markAutoModeLedgerFailed(
        ledger?.id ?? "",
        "jane@example.com",
        "g-1",
        new AutoReplyNotSentError("error"),
      ),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    expect(captureError).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("one lock for both paths: auto-mode and the rule sweep claim the SAME key", () => {
  const autoModeHarness = (over: Partial<Parameters<typeof runAutoModeSweep>[2]> = {}) => {
    const send = vi.fn(async () => {});
    const resolveItem = vi.fn(async () => {});
    const deps: Parameters<typeof runAutoModeSweep>[2] = {
      findCandidates: async () => [{ id: "item-1", sourceId: "row-1" }],
      findEmail: async () => ({ ...email, body: "hi" }),
      alreadyReplied: hasAutoReplyClaim, // production wiring
      isSingleRecipient: () => true,
      draftReply: async () => "a fine reply",
      emailStillExists: async () => true,
      writeLedger: ensureAutoModeReplyNotification, // production wiring
      send,
      markLedgerFailed: async () => {},
      resolveItem,
      warn: () => {},
      reportError: () => {},
      now: () => 0,
      ...over,
    };
    return { deps, send, resolveItem };
  };

  it("a rule claim landing BETWEEN auto-mode's dedupe check and its own claim makes auto-mode lose (P2002) and not send", async () => {
    const { deps, send, resolveItem } = autoModeHarness({
      alreadyReplied: async (userId, gmailId) => {
        const claimed = await hasAutoReplyClaim(userId, gmailId); // false: nothing yet
        // An overlapping cycle's rule path claims in the gap.
        await claimAutoReplyLedger(userId, gmailId, "jane@example.com", "vip rule");
        return claimed;
      },
    });

    await runAutoModeSweep(USER, "guideline", deps);

    expect(send).not.toHaveBeenCalled();
    expect(resolveItem).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(1);
  });

  it("an auto-mode claim landing BETWEEN the rule path's dedupe check and its own claim makes the rule path lose and not send", async () => {
    expect(await hasAutoReplyClaim(USER, email.gmailId)).toBe(false); // rule pre-filter passes
    await ensureAutoModeReplyNotification(USER, email.gmailId, "jane@example.com"); // gap

    await expect(deliverRuleAutoReply(USER, email, "thanks!", "vip rule")).resolves.toBeUndefined();

    expect(executeToolCall).not.toHaveBeenCalled();
  });

  it("an auto-mode send failure keeps the shared key, so the rule path never re-sends that mail", async () => {
    const failingSend = vi.fn(async () => {
      throw new AutoReplyNotSentError("error");
    });
    const { deps, resolveItem } = autoModeHarness({
      send: failingSend,
      markLedgerFailed: markAutoModeLedgerFailed,
    });

    await runAutoModeSweep(USER, "guideline", deps);

    expect(failingSend).toHaveBeenCalledTimes(1);
    expect(resolveItem).not.toHaveBeenCalled();
    expect(store.rows[0]?.title).toBe("Auto-mode reply not confirmed");
    expect(await hasAutoReplyClaim(USER, email.gmailId)).toBe(true);
    await deliverRuleAutoReply(USER, email, "thanks!", "vip rule");
    expect(executeToolCall).not.toHaveBeenCalled();
  });
});

describe("clearNotifications keeps reply claims (they are at-most-once locks, not bell entries)", () => {
  it("clear -> the claim survives -> the failed mail is never re-sent, and the bell is visually cleared", async () => {
    // A failed (delivery-unknown) rule reply, plus ordinary notifications.
    executeToolCall.mockResolvedValueOnce(JSON.stringify({ error: "socket hang up" }));
    await deliverRuleAutoReply(USER, email, "thanks!", "vip rule").catch(() => {});
    store.rows.push(
      {
        id: "a",
        userId: USER,
        type: "task",
        dedupeKey: null,
        title: "t",
        message: "m",
        createdAt: new Date(),
      },
      {
        id: "b",
        userId: USER,
        type: "briefing",
        dedupeKey: "briefing:2026-09-30",
        title: "b",
        message: "m",
        createdAt: new Date(),
      },
      {
        id: "c",
        userId: "someone-else",
        type: "task",
        dedupeKey: null,
        title: "t",
        message: "m",
        createdAt: new Date(),
      },
    );
    expect(await getNotifications(USER)).toHaveLength(3);

    await clearNotifications(USER);

    // Bell cleared...
    expect(await getNotifications(USER)).toHaveLength(0);
    // ...ordinary rows gone, other users untouched, the claim kept.
    expect(store.rows.map((r) => r.id).sort()).toEqual(["c", ledgerRow().id].sort());
    expect(ledgerRow().dedupeKey).toBe("auto-reply:g-1");
    expect(ledgerRow().isRead).toBe(true);
    // The lock still holds: neither path can re-send after the clear.
    expect(await hasAutoReplyClaim(USER, email.gmailId)).toBe(true);
    await deliverRuleAutoReply(USER, email, "thanks!", "vip rule");
    expect(executeToolCall).toHaveBeenCalledTimes(1);
  });

  it("keeps a legacy auto-mode-reply: claim too", async () => {
    store.rows.push({
      id: "old",
      userId: USER,
      type: "email",
      dedupeKey: "auto-mode-reply:g-9",
      title: "Klorn replied for you",
      message: "m",
      createdAt: new Date(),
    });

    await clearNotifications(USER);

    expect(store.rows.map((r) => r.id)).toEqual(["old"]);
    expect(await hasAutoReplyClaim(USER, "g-9")).toBe(true);
    expect(await getNotifications(USER)).toHaveLength(0);
  });

  it("a second clear is idempotent", async () => {
    await ensureAutoModeReplyNotification(USER, "g-1", "jane@example.com");
    await clearNotifications(USER);
    await clearNotifications(USER);
    expect(store.rows).toHaveLength(1);
  });
});

describe("runRuleAutoReply — validate before any LLM spend", () => {
  const rule = { ruleName: "vip rule", actionValue: "be brief" };
  const setup = (over: { from?: string; exists?: boolean } = {}) => {
    const draftReply = vi.fn(async () => {
      store.log.push("draft");
      return "thanks!";
    });
    const emailStillExists = vi.fn(async () => {
      store.log.push("exists");
      return over.exists ?? true;
    });
    const run = () =>
      runRuleAutoReply(USER, { ...email, from: over.from ?? email.from }, rule, {
        draftReply,
        emailStillExists,
      });
    return { draftReply, emailStillExists, run };
  };

  it("a crafted multi-recipient From never reaches the LLM, the claim or the send", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { draftReply, run } = setup({ from: "a@x.com, b@evil.com" });

    await expect(run()).resolves.toBeUndefined();

    expect(draftReply).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(0);
    expect(executeToolCall).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).not.toContain("evil.com");
    warn.mockRestore();
  });

  it("runs draft -> source-still-exists -> claim -> send, in that order", async () => {
    const { run } = setup();

    await run();

    expect(store.log).toEqual([
      "draft",
      "exists",
      "notification.create",
      "send",
      "notification.update",
    ]);
  });

  it("skips (no claim, no send) when the source row vanished during the draft", async () => {
    const { run } = setup({ exists: false });

    await run();

    expect(store.rows).toHaveLength(0);
    expect(executeToolCall).not.toHaveBeenCalled();
  });
});
