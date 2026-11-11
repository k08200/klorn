import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Auth passthrough — these tests target reject-with-feedback persistence and
// the approve CAS, not the auth layer.
vi.mock("../auth.js", () => ({
  resolveEffectiveJwtSecret: () => "test-secret",
  requireAuth: async () => {},
  getUserId: () => "test-user-id",
}));

const executeToolCallSpy = vi.fn();
vi.mock("../agentcore/tool-executor.js", () => ({
  executeToolCall: (...args: unknown[]) => executeToolCallSpy(...args),
}));

vi.mock("../judge/attention-mirror.js", () => ({
  upsertAttentionForPendingAction: vi.fn(async () => {}),
}));

vi.mock("../agentcore/action-target.js", () => ({
  resolveActionTarget: vi.fn(async () => null),
}));

const recordFeedbackSpy = vi.fn(async () => {});
vi.mock("../learning/feedback.js", () => ({
  recordFeedback: (...args: unknown[]) => recordFeedbackSpy(...args),
  recipientFromToolArgs: () => null,
}));

vi.mock("../websocket.js", () => ({
  pushNotification: vi.fn(),
}));

// Dynamically imported by the routes — stub so importing them never pulls
// in openai/googleapis.
vi.mock("../learning/pattern-learner.js", () => ({
  learnFromApproval: vi.fn(async () => {}),
  learnFromRejection: vi.fn(async () => {}),
}));
vi.mock("../learning/memory.js", () => ({
  remember: vi.fn(async () => {}),
}));

// In-memory PendingAction row with an atomic compare-and-swap updateMany —
// the same guarantee Postgres gives a conditional UPDATE. findUnique
// deliberately returns a PENDING snapshot every time so two concurrent
// requests both pass the pre-check and the CAS is the only thing standing
// between the user and a double execution.
type Row = {
  id: string;
  userId: string;
  conversationId: string;
  status: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  reasoning: string | null;
  result: string | null;
  rejectionReason: string | null;
  createdAt: Date;
};

const ledger = vi.hoisted(() => ({
  emailFindFirst: vi.fn(),
  labelUpdateMany: vi.fn(),
}));

let row: Row;
let staleReads: boolean;
const updateManyCalls: Array<Record<string, unknown>> = [];

vi.mock("../db.js", () => {
  const pendingAction = {
    findUnique: vi.fn(async () => {
      if (!row) return null;
      // Simulate the read-before-claim race: both concurrent requests see
      // the row as PENDING when staleReads is on.
      return staleReads ? { ...row, status: "PENDING" } : { ...row };
    }),
    updateMany: vi.fn(
      async (args: { where: { id: string; status: string }; data: Record<string, unknown> }) => {
        updateManyCalls.push(args.data);
        if (args.where.id !== row.id || args.where.status !== row.status) {
          return { count: 0 };
        }
        row = { ...row, ...(args.data as Partial<Row>) };
        return { count: 1 };
      },
    ),
    update: vi.fn(async (args: { data: Record<string, unknown> }) => {
      row = { ...row, ...(args.data as Partial<Row>) };
      return { ...row };
    }),
    findFirst: vi.fn(async () => null),
  };
  // In-memory ActionOutbox — the approve path now routes through the
  // transactional outbox (T6). One row per pendingActionId; updateMany is the
  // CAS claim (QUEUED→IN_PROGRESS), update writes the terminal state.
  let outboxRow: Record<string, unknown> | null = null;
  const actionOutbox = {
    create: vi.fn(async (args: { data: Record<string, unknown> }) => {
      outboxRow = { ...args.data, id: "ob-1", attempts: 0, updatedAt: new Date() };
      return { ...outboxRow };
    }),
    findUnique: vi.fn(async () => (outboxRow ? { ...outboxRow } : null)),
    findMany: vi.fn(async () => []),
    updateMany: vi.fn(
      async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!outboxRow) return { count: 0 };
        if (args.where.status && outboxRow.status !== args.where.status) return { count: 0 };
        outboxRow = { ...outboxRow, ...args.data };
        return { count: 1 };
      },
    ),
    update: vi.fn(async (args: { data: Record<string, unknown> }) => {
      outboxRow = { ...(outboxRow ?? {}), ...args.data };
      return { ...outboxRow };
    }),
  };
  const prisma = {
    pendingAction,
    actionOutbox,
    message: { create: vi.fn(async () => ({ id: "m-new" })) },
    conversation: { findUnique: vi.fn(async () => null), update: vi.fn(async () => ({})) },
    automationConfig: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({})) },
    attentionItem: { updateMany: vi.fn(async () => ({ count: 0 })) },
    // An approved reply stamps REPLIED (judge/user-outcome.ts noteReplyIfSent).
    emailMessage: { findFirst: ledger.emailFindFirst },
    decisionLabel: { updateMany: ledger.labelUpdateMany },
    // The approve route claims the PA and enqueues in one transaction; the
    // mock runs the callback against the same prisma object (no real txn).
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  return { prisma, db: prisma, INTERACTIVE_TX_OPTIONS: { maxWait: 10_000, timeout: 15_000 } };
});

async function buildApp() {
  const { chatRoutes } = await import("../routes/chat-pending-actions.js");
  const app = Fastify();
  await app.register(chatRoutes, { prefix: "/api/chat" });
  return app;
}

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "pa-1",
    userId: "test-user-id",
    conversationId: "c-1",
    status: "PENDING",
    toolName: "create_event",
    toolArgs: { summary: "Standup", start_time: "2026-06-13T09:00:00Z" },
    reasoning: null,
    result: null,
    rejectionReason: null,
    createdAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  row = makeRow();
  staleReads = false;
  updateManyCalls.length = 0;
  executeToolCallSpy.mockReset();
  executeToolCallSpy.mockResolvedValue("ok");
  recordFeedbackSpy.mockClear();
  ledger.emailFindFirst.mockReset();
  ledger.emailFindFirst.mockResolvedValue({ id: "email-1" });
  ledger.labelUpdateMany.mockReset();
  ledger.labelUpdateMany.mockResolvedValue({ count: 1 });
});

describe("POST /api/chat/pending-actions/:actionId/reject — reject with feedback", () => {
  it("persists the trimmed rejection reason on the PendingAction row", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/pending-actions/pa-1/reject",
      payload: { reason: "  Wrong recipient — never email this person  " },
    });

    expect(res.statusCode).toBe(200);
    expect(row.status).toBe("REJECTED");
    expect(row.rejectionReason).toBe("Wrong recipient — never email this person");
    await app.close();
  });

  it("still rejects without a reason (back-compat) and leaves rejectionReason null", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/pending-actions/pa-1/reject",
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(row.status).toBe("REJECTED");
    expect(row.rejectionReason).toBeNull();
    await app.close();
  });

  it("rejects a whitespace-only reason with 400", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/pending-actions/pa-1/reject",
      payload: { reason: "   " },
    });

    expect(res.statusCode).toBe(400);
    expect(row.status).toBe("PENDING");
    await app.close();
  });

  it("rejects a reason longer than 500 chars with 400", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/pending-actions/pa-1/reject",
      payload: { reason: "x".repeat(501) },
    });

    expect(res.statusCode).toBe(400);
    expect(row.status).toBe("PENDING");
    await app.close();
  });

  it("passes the reason into the feedback ledger as evidence", async () => {
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/chat/pending-actions/pa-1/reject",
      payload: { reason: "Too aggressive follow-up" },
    });

    expect(recordFeedbackSpy).toHaveBeenCalledWith(
      expect.objectContaining({ signal: "REJECTED", evidence: "Too aggressive follow-up" }),
    );
    await app.close();
  });
});

describe("POST /api/chat/pending-actions/:actionId/approve — execution idempotency", () => {
  it("executes exactly once when two approve requests race past the pre-check", async () => {
    staleReads = true; // both requests read status=PENDING before either claims
    const app = await buildApp();

    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url: "/api/chat/pending-actions/pa-1/approve", payload: {} }),
      app.inject({ method: "POST", url: "/api/chat/pending-actions/pa-1/approve", payload: {} }),
    ]);

    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    expect(executeToolCallSpy).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("replays the persisted toolArgs deterministically (no re-generation)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/pending-actions/pa-1/approve",
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "test-user-id",
      "create_event",
      { summary: "Standup", start_time: "2026-06-13T09:00:00Z" },
      null,
    );
    await app.close();
  });

  it("claims with pool-sized $transaction options — the default maxWait (2s) turned pool starvation into P2028 500s (#845)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/pending-actions/pa-1/approve",
      payload: {},
    });
    expect(res.statusCode).toBe(200);

    const { prisma } = (await import("../db.js")) as unknown as {
      prisma: { $transaction: ReturnType<typeof vi.fn> };
    };
    const opts = prisma.$transaction.mock.calls[0][1] as
      | { maxWait?: number; timeout?: number }
      | undefined;
    expect(opts?.maxWait).toBeGreaterThanOrEqual(10_000);
    expect(opts?.timeout).toBeGreaterThanOrEqual(15_000);
    await app.close();
  });

  it("refuses to approve an action that is already EXECUTED", async () => {
    row = makeRow({ status: "EXECUTED" });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/pending-actions/pa-1/approve",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(executeToolCallSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("dead-letters a permanent tool error (500 FAILED, no retry)", async () => {
    executeToolCallSpy.mockRejectedValueOnce(new Error("missing required field: to"));
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/pending-actions/pa-1/approve",
      payload: {},
    });

    expect(res.statusCode).toBe(500);
    expect(row.status).toBe("FAILED");
    expect(executeToolCallSpy).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("queues a transient tool failure for retry instead of failing (200, stays EXECUTED)", async () => {
    // T6 behavior change: a transient blip no longer drops the action to
    // FAILED — the row stays claimed and the worker retries it.
    executeToolCallSpy.mockRejectedValueOnce(new Error("503 upstream unavailable"));
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/pending-actions/pa-1/approve",
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, queued: true });
    expect(row.status).toBe("EXECUTED"); // claimed, not FAILED
    expect(executeToolCallSpy).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

describe("POST /api/chat/pending-actions/:actionId/approve — decision ledger", () => {
  const REPLY_ARGS = {
    to: "boss@corp.example",
    subject: "Re: Q4",
    body: "Sounds good.",
    in_reply_to_email_id: "gmail-77",
  };
  const approve = async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/pending-actions/pa-1/approve",
      payload: {},
    });
    await app.close();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    return res;
  };

  it("stamps REPLIED once on the answered mail when the approved reply went out", async () => {
    row = makeRow({ toolName: "send_email", toolArgs: REPLY_ARGS });
    const before = new Date();
    const res = await approve();

    expect(res.statusCode).toBe(200);
    // Proof the send happened: markEmailReplied set repliedAt during this approval.
    const where = ledger.emailFindFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({
      userId: "test-user-id",
      OR: [{ id: "gmail-77" }, { gmailId: "gmail-77" }],
    });
    expect(where.repliedAt.gte.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(ledger.labelUpdateMany.mock.calls.map((c) => c[0])).toEqual([
      {
        where: { userId: "test-user-id", source: "EMAIL", sourceId: "email-1", repliedAt: null },
        data: { repliedAt: expect.any(Date) },
      },
    ]);
  });

  it("stamps nothing when the send left no fresh repliedAt (refused by the provider)", async () => {
    row = makeRow({ toolName: "send_email", toolArgs: REPLY_ARGS });
    ledger.emailFindFirst.mockResolvedValue(null);
    await approve();
    expect(ledger.labelUpdateMany).not.toHaveBeenCalled();
  });

  it("looks nothing up for a new mail or a non-mail action", async () => {
    const { in_reply_to_email_id: _drop, ...newMail } = REPLY_ARGS;
    row = makeRow({ toolName: "send_email", toolArgs: newMail });
    await approve();
    row = makeRow();
    await approve();
    expect(ledger.emailFindFirst).not.toHaveBeenCalled();
  });

  it("stamps nothing while the send is only queued for retry", async () => {
    row = makeRow({ toolName: "send_email", toolArgs: REPLY_ARGS });
    executeToolCallSpy.mockRejectedValueOnce(new Error("503 upstream unavailable"));
    const res = await approve();
    expect(res.json()).toMatchObject({ queued: true });
    expect(ledger.emailFindFirst).not.toHaveBeenCalled();
  });

  it("answers exactly the same when the ledger write fails", async () => {
    row = makeRow({ toolName: "send_email", toolArgs: REPLY_ARGS });
    const ok = await approve();
    row = makeRow({ toolName: "send_email", toolArgs: REPLY_ARGS });
    ledger.labelUpdateMany.mockRejectedValue(new Error("ledger down"));
    const failed = await approve();

    expect(failed.statusCode).toBe(ok.statusCode);
    expect(failed.body).toBe(ok.body);
  });
});
