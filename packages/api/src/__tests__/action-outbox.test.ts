/**
 * Transactional outbox (T6) — the durable action-execution substrate.
 * db.js, tool-executor, websocket, and the lazy side-effect modules are
 * mocked; isTransientToolError uses the real pure classifier.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const executeToolCall = vi.hoisted(() => vi.fn());
const pushNotification = vi.hoisted(() => vi.fn());
const recordFeedback = vi.hoisted(() => vi.fn(async () => {}));

// In-memory ActionOutbox + PendingAction stores so we can assert state.
const outboxStore = vi.hoisted(() => new Map<string, Record<string, unknown>>());
const paStore = vi.hoisted(() => new Map<string, Record<string, unknown>>());
const messages = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("../db.js", () => {
  const actionOutbox = {
    findMany: vi.fn(
      async (args: { where: Record<string, unknown>; orderBy?: unknown; take?: number }) => {
        const w = args.where;
        let rows = [...outboxStore.values()];
        if (w.status) rows = rows.filter((r) => r.status === w.status);
        if (w.nextAttemptAt && typeof w.nextAttemptAt === "object") {
          const lte = (w.nextAttemptAt as { lte: Date }).lte;
          rows = rows.filter((r) => (r.nextAttemptAt as Date).getTime() <= lte.getTime());
        }
        rows.sort(
          (a, b) => (a.nextAttemptAt as Date).getTime() - (b.nextAttemptAt as Date).getTime(),
        );
        return rows.slice(0, args.take ?? 100).map((r) => ({ ...r }));
      },
    ),
    findUnique: vi.fn(async (args: { where: { pendingActionId?: string; id?: string } }) => {
      const key = args.where.pendingActionId ?? args.where.id;
      const row = [...outboxStore.values()].find((r) => r.pendingActionId === key || r.id === key);
      return row ? { ...row } : null;
    }),
    updateMany: vi.fn(
      async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let n = 0;
        for (const r of outboxStore.values()) {
          if (args.where.id && r.id !== args.where.id) continue;
          if (args.where.status && r.status !== args.where.status) continue;
          if (
            args.where.updatedAt &&
            (r.updatedAt as Date).getTime() > (args.where.updatedAt as { lte: Date }).lte.getTime()
          ) {
            continue;
          }
          Object.assign(r, args.data, { updatedAt: new Date() });
          n++;
        }
        return { count: n };
      },
    ),
    update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const r = outboxStore.get(args.where.id);
      if (!r) throw new Error("not found");
      Object.assign(r, args.data, { updatedAt: new Date() });
      return { ...r };
    }),
  };
  const pendingAction = {
    update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const r = paStore.get(args.where.id) ?? { id: args.where.id };
      Object.assign(r, args.data);
      paStore.set(args.where.id, r);
      return { ...r };
    }),
    findUnique: vi.fn(async (args: { where: { id: string } }) => {
      const r = paStore.get(args.where.id);
      return r ? { ...r } : null;
    }),
  };
  const message = {
    create: vi.fn(async (a: { data: unknown }) => messages.push(a.data as object)),
  };
  const prisma = { actionOutbox, pendingAction, message };
  return { prisma, db: prisma };
});

vi.mock("../tool-executor.js", () => ({
  executeToolCall: (...a: unknown[]) => executeToolCall(...a),
}));
vi.mock("../websocket.js", () => ({ pushNotification }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../pattern-learner.js", () => ({ learnFromApproval: vi.fn(async () => {}) }));
vi.mock("../attention-mirror.js", () => ({
  upsertAttentionForPendingAction: vi.fn(async () => {}),
}));
vi.mock("../feedback.js", () => ({
  recordFeedback,
  recipientFromToolArgs: () => null,
}));

import {
  claimAndRunOutboxRow,
  deriveIdempotencyKey,
  drainActionOutbox,
  isTransientToolError,
  type OutboxRow,
} from "../action-outbox.js";

const NOW = new Date("2026-06-12T12:00:00Z");

function seedRow(overrides: Partial<Record<string, unknown>> = {}): OutboxRow {
  const row = {
    id: overrides.id ?? "ob-1",
    pendingActionId: "pa-1",
    userId: "u-1",
    toolName: "create_event",
    toolArgs: { summary: "Standup" },
    actionReceipt: null,
    idempotencyKey: "k-1",
    status: "QUEUED",
    attempts: 0,
    maxAttempts: 5,
    nextAttemptAt: NOW,
    conversationId: "c-1",
    updatedAt: NOW,
    ...overrides,
  } as Record<string, unknown>;
  outboxStore.set(row.id as string, row);
  paStore.set(row.pendingActionId as string, {
    id: row.pendingActionId,
    userId: "u-1",
    toolName: row.toolName,
    status: "EXECUTED",
    reasoning: null,
    conversationId: "c-1",
  });
  return row as unknown as OutboxRow;
}

beforeEach(() => {
  outboxStore.clear();
  paStore.clear();
  messages.length = 0;
  executeToolCall.mockReset();
  pushNotification.mockReset();
  recordFeedback.mockClear();
});

describe("deriveIdempotencyKey", () => {
  it("is stable regardless of arg key order", () => {
    const a = deriveIdempotencyKey("pa-1", "send_email", { to: "x@y.z", subject: "Hi", body: "B" });
    const b = deriveIdempotencyKey("pa-1", "send_email", { body: "B", to: "x@y.z", subject: "Hi" });
    expect(a).toBe(b);
  });
  it("differs by pendingActionId, tool, and args", () => {
    const base = deriveIdempotencyKey("pa-1", "send_email", { to: "x" });
    expect(deriveIdempotencyKey("pa-2", "send_email", { to: "x" })).not.toBe(base);
    expect(deriveIdempotencyKey("pa-1", "delete_permanent", { to: "x" })).not.toBe(base);
    expect(deriveIdempotencyKey("pa-1", "send_email", { to: "y" })).not.toBe(base);
  });
});

describe("isTransientToolError", () => {
  it.each([
    new Error("503 Service Unavailable"),
    new Error("429 rate limited"),
    Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    new Error("request timed out"),
    new Error("socket hang up"),
  ])("transient: %s", (e) => expect(isTransientToolError(e)).toBe(true));

  it.each([
    Object.assign(new Error("payload mismatch"), { name: "ActionReceiptMismatchError" }),
    Object.assign(new Error("receipt required"), { name: "FloorReceiptRequiredError" }),
    Object.assign(new Error("bad arg"), { name: "ToolValidationError" }),
    new Error("missing required field: to"),
    new Error("gmail down"),
  ])("permanent: %s", (e) => expect(isTransientToolError(e)).toBe(false));
});

describe("claimAndRunOutboxRow", () => {
  it("completes: executes, marks COMPLETED, writes PA result + chat message + APPROVED feedback", async () => {
    const row = seedRow();
    executeToolCall.mockResolvedValue("done");
    const outcome = await claimAndRunOutboxRow(row, NOW);
    expect(outcome).toEqual({ kind: "completed", result: "done" });
    expect(outboxStore.get("ob-1")?.status).toBe("COMPLETED");
    expect(paStore.get("pa-1")?.result).toBe("done");
    expect(messages.some((m) => /completed/.test(String(m.content)))).toBe(true);
    expect(pushNotification).toHaveBeenCalled();
    // APPROVED fires at completion (mutually exclusive with FAILED on dead).
    expect(recordFeedback).toHaveBeenCalledWith(expect.objectContaining({ signal: "APPROVED" }));
  });

  it("treats a swallowed non-floor tool error ({error}) as a failure, not success", async () => {
    // tool-executor returns JSON.stringify({error}) for non-floor failures
    // instead of throwing — the outbox must not record that as COMPLETED.
    const row = seedRow();
    executeToolCall.mockResolvedValue(JSON.stringify({ error: "503 upstream" }));
    const outcome = await claimAndRunOutboxRow(row, NOW);
    expect(outcome.kind).toBe("retry"); // 503 is transient
    expect(outboxStore.get("ob-1")?.status).toBe("QUEUED");
    expect(recordFeedback).not.toHaveBeenCalledWith(
      expect.objectContaining({ signal: "APPROVED" }),
    );
  });

  it("dead-letters a swallowed permanent tool error ({error: not found})", async () => {
    const row = seedRow();
    executeToolCall.mockResolvedValue(JSON.stringify({ error: "calendar event not found" }));
    const outcome = await claimAndRunOutboxRow(row, NOW);
    expect(outcome.kind).toBe("dead");
    expect(outboxStore.get("ob-1")?.status).toBe("DEAD");
  });

  it("does NOT mistake a tool result that legitimately carries an error field", async () => {
    // {conflicts, error:null} or {error, data} are real results, not the
    // strict single-key {error:string} failure shape.
    const row = seedRow();
    executeToolCall.mockResolvedValue(JSON.stringify({ error: "x", data: [1, 2] }));
    const outcome = await claimAndRunOutboxRow(row, NOW);
    expect(outcome.kind).toBe("completed");
  });

  it("loses the claim when the row is already IN_PROGRESS (no double execute)", async () => {
    const row = seedRow({ status: "IN_PROGRESS" });
    const outcome = await claimAndRunOutboxRow(row, NOW);
    expect(outcome).toEqual({ kind: "lost" });
    expect(executeToolCall).not.toHaveBeenCalled();
  });

  it("retries a transient failure with backoff, staying QUEUED", async () => {
    const row = seedRow();
    executeToolCall.mockRejectedValue(new Error("503 upstream"));
    const outcome = await claimAndRunOutboxRow(row, NOW);
    expect(outcome.kind).toBe("retry");
    const stored = outboxStore.get("ob-1");
    expect(stored?.status).toBe("QUEUED");
    expect(stored?.attempts).toBe(1);
    // backoff = 30s for the first retry
    expect((stored?.nextAttemptAt as Date).getTime()).toBe(NOW.getTime() + 30_000);
    // PA stays EXECUTED (claimed), not FAILED
    expect(paStore.get("pa-1")?.status).toBe("EXECUTED");
  });

  it("dead-letters a transient failure on the last allowed attempt", async () => {
    const row = seedRow({ attempts: 4, maxAttempts: 5 });
    executeToolCall.mockRejectedValue(new Error("timeout"));
    const outcome = await claimAndRunOutboxRow(row, NOW);
    expect(outcome.kind).toBe("dead");
    expect(outboxStore.get("ob-1")?.status).toBe("DEAD");
    expect(paStore.get("pa-1")?.status).toBe("FAILED");
  });

  it("dead-letters a permanent failure immediately, regardless of attempts left", async () => {
    const row = seedRow({ attempts: 0, maxAttempts: 5 });
    executeToolCall.mockRejectedValue(new Error("missing required field: to"));
    const outcome = await claimAndRunOutboxRow(row, NOW);
    expect(outcome.kind).toBe("dead");
    expect(outboxStore.get("ob-1")?.status).toBe("DEAD");
  });

  it("NEVER retries a receipt mismatch (floor tamper is permanent)", async () => {
    const row = seedRow({ attempts: 0, maxAttempts: 5 });
    executeToolCall.mockRejectedValue(
      Object.assign(new Error("payloadHash mismatch"), { name: "ActionReceiptMismatchError" }),
    );
    const outcome = await claimAndRunOutboxRow(row, NOW);
    expect(outcome.kind).toBe("dead");
    expect(outboxStore.get("ob-1")?.attempts).toBe(1);
  });

  it("passes the stored receipt through to executeToolCall (floor intact)", async () => {
    const receipt = { v: "v1", action: "send_email", payloadHash: "abc" };
    const row = seedRow({
      toolName: "send_email",
      toolArgs: { to: "a@b.c" },
      actionReceipt: receipt,
    });
    executeToolCall.mockResolvedValue("sent");
    await claimAndRunOutboxRow(row, NOW);
    expect(executeToolCall).toHaveBeenCalledWith("u-1", "send_email", { to: "a@b.c" }, receipt);
  });
});

describe("drainActionOutbox", () => {
  it("claims and runs due QUEUED rows, returning counts", async () => {
    seedRow({ id: "ob-a", pendingActionId: "pa-a" });
    seedRow({ id: "ob-b", pendingActionId: "pa-b" });
    executeToolCall.mockResolvedValue("ok");
    const res = await drainActionOutbox(NOW);
    expect(res.claimed).toBe(2);
    expect(res.completed).toBe(2);
    expect(outboxStore.get("ob-a")?.status).toBe("COMPLETED");
  });

  it("skips rows whose nextAttemptAt is in the future", async () => {
    seedRow({ id: "ob-future", nextAttemptAt: new Date(NOW.getTime() + 60_000) });
    executeToolCall.mockResolvedValue("ok");
    const res = await drainActionOutbox(NOW);
    expect(res.claimed).toBe(0);
    expect(executeToolCall).not.toHaveBeenCalled();
  });

  it("reclaims rows orphaned IN_PROGRESS by a crashed worker", async () => {
    seedRow({
      id: "ob-stale",
      status: "IN_PROGRESS",
      updatedAt: new Date(NOW.getTime() - 10 * 60 * 1000),
    });
    executeToolCall.mockResolvedValue("ok");
    const res = await drainActionOutbox(NOW);
    expect(res.reclaimed).toBe(1);
    // reclaimed → QUEUED at now → then claimed + run in the same drain
    expect(res.completed).toBe(1);
  });

  it("does not reclaim a freshly IN_PROGRESS row (within the stale window)", async () => {
    seedRow({ id: "ob-fresh", status: "IN_PROGRESS", updatedAt: NOW });
    const res = await drainActionOutbox(NOW);
    expect(res.reclaimed).toBe(0);
    expect(res.claimed).toBe(0);
  });
});
