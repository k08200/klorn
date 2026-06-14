import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Auth passthrough — these tests target reject-with-feedback persistence and
// the approve CAS, not the auth layer.
vi.mock("../auth.js", () => ({
  requireAuth: async () => {},
  getUserId: () => "test-user-id",
}));

const executeToolCallSpy = vi.fn();
vi.mock("../tool-executor.js", () => ({
  executeToolCall: (...args: unknown[]) => executeToolCallSpy(...args),
}));

vi.mock("../attention-mirror.js", () => ({
  upsertAttentionForPendingAction: vi.fn(async () => {}),
}));

vi.mock("../action-target.js", () => ({
  resolveActionTarget: vi.fn(async () => null),
}));

const recordFeedbackSpy = vi.fn(async () => {});
vi.mock("../feedback.js", () => ({
  recordFeedback: (...args: unknown[]) => recordFeedbackSpy(...args),
  recipientFromToolArgs: () => null,
}));

vi.mock("../websocket.js", () => ({
  pushNotification: vi.fn(),
}));

// Dynamically imported by the routes — stub so importing them never pulls
// in openai/googleapis.
vi.mock("../pattern-learner.js", () => ({
  learnFromApproval: vi.fn(async () => {}),
  learnFromRejection: vi.fn(async () => {}),
}));
vi.mock("../memory.js", () => ({
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
    // The approve route claims the PA and enqueues in one transaction; the
    // mock runs the callback against the same prisma object (no real txn).
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  return { prisma, db: prisma };
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
