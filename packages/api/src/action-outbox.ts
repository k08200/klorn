/**
 * Transactional outbox for action execution (T6).
 *
 * The approve route used to execute a tool INLINE inside the HTTP request
 * with no retry: a transient blip (Gmail 503, socket reset) sent the action
 * straight to FAILED, and the user had to notice and re-click. For a human
 * that's annoying; for autonomous (AUTO) execution it silently drops the
 * action. This module is the durable substrate that fixes both and is the
 * prerequisite for turning on AUTO execution.
 *
 * Shape (the classic transactional-outbox pattern):
 *   1. enqueueAction() writes the execution intent in the SAME transaction
 *      as the PendingAction status claim — approval and "this must run"
 *      commit atomically, so a crash between them cannot drop the action.
 *   2. runOutboxAttempt() executes ONE attempt by replaying the stored
 *      toolArgs + receipt. The LLM is never here — retries replay persisted
 *      bytes, not model decisions.
 *   3. drainActionOutbox() is the worker: claim due QUEUED rows with an
 *      atomic CAS, attempt each, and on transient failure reschedule with
 *      exponential backoff (permanent failures and receipt mismatches go
 *      straight to DEAD — a dead-letter the operator can inspect).
 *
 * The deterministic floor is untouched: the worker passes the stored receipt
 * to executeToolCall, which still verifies payloadHash and refuses on
 * mismatch. Replaying can never weaken it.
 *
 * Honest scope:
 *   - Delivery is at-least-once. The CAS claim makes execution
 *     at-most-once-PER-ATTEMPT (no concurrent double-fire), but a crash
 *     AFTER a tool succeeds and BEFORE the COMPLETED write leaves a narrow
 *     window where a retry re-runs the tool. idempotencyKey is stored and
 *     threaded so a future per-tool dedup can close that window; today only
 *     the floor receipt constrains re-sends (it verifies bytes, not
 *     duplicates), so non-floor tools (create_event, ...) can double-fire
 *     in that window. Acceptable for the human-approve path; the per-tool
 *     dedup is the prerequisite to wire BEFORE enabling autonomous execution.
 *   - This PR does NOT enable AUTO execution. It only routes the existing
 *     human-approve path through the outbox (durability + retry). AUTO stays
 *     classify-only per POC.md; an autonomous caller would enqueue without
 *     the inline attempt and let the worker run it.
 */

import { createHash } from "node:crypto";
import type { ActionReceipt } from "./attention-floor.js";
import { db } from "./db.js";
import { isConnectionError, isKeyLimitError } from "./llm/model-fallback.js";
import { captureError } from "./sentry.js";
import { executeToolCall } from "./tool-executor.js";
import { pushNotification } from "./websocket.js";

export type OutboxStatus = "QUEUED" | "IN_PROGRESS" | "COMPLETED" | "DEAD";

const DEFAULT_MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 30_000; // 30s, then 4x each retry: 30s, 2m, 8m, 32m
const BACKOFF_FACTOR = 4;
const BACKOFF_CAP_MS = 60 * 60 * 1000; // 1h
const DRAIN_BATCH = 25;
// A row claimed (IN_PROGRESS) but never moved to a terminal state means the
// worker crashed mid-attempt. After this long it's reclaimed to QUEUED. The
// claim already incremented attempts, so a reclaim still counts toward
// maxAttempts — a tool that hard-crashes the process can't loop forever.
const STALE_IN_PROGRESS_MS = 5 * 60 * 1000;

export interface OutboxRow {
  id: string;
  pendingActionId: string;
  userId: string;
  toolName: string;
  toolArgs: unknown;
  actionReceipt: unknown;
  idempotencyKey: string;
  status: OutboxStatus;
  attempts: number;
  maxAttempts: number;
  conversationId?: string | null;
}

/**
 * Stable identity of an action, independent of retries. Anchored on the
 * PendingAction id (one logical action) plus the tool + a content hash of
 * the args, so a re-enqueue of the same approval yields the same key.
 */
export function deriveIdempotencyKey(
  pendingActionId: string,
  toolName: string,
  toolArgs: unknown,
): string {
  const argsJson = stableStringify(toolArgs);
  return createHash("sha256").update(`${pendingActionId}\n${toolName}\n${argsJson}`).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * Whether a tool execution error is worth retrying. Transient = the call
 * could plausibly succeed on a later attempt (network, upstream 5xx, rate
 * limit). Everything else is permanent and dead-letters immediately.
 *
 * Receipt/floor errors are ALWAYS permanent: a payloadHash mismatch is a
 * tamper/staleness signal, never a blip — retrying it would be a security
 * hole, not a recovery.
 */
export function isTransientToolError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  if (
    name === "FloorReceiptRequiredError" ||
    name === "ActionReceiptMismatchError" ||
    name === "ActionReceiptSchemaError" ||
    name === "ToolValidationError"
  ) {
    return false;
  }
  if (isConnectionError(err) || isKeyLimitError(err)) return true;
  const message = err instanceof Error ? err.message.toLowerCase() : "";
  if (!message) return false;
  if (/\b(502|503|504|429)\b/.test(message)) return true;
  return /timeout|timed out|temporarily|try again|econnreset|socket hang up|network|upstream/.test(
    message,
  );
}

function backoffMs(attempts: number): number {
  const raw = BACKOFF_BASE_MS * BACKOFF_FACTOR ** Math.max(0, attempts - 1);
  return Math.min(raw, BACKOFF_CAP_MS);
}

/**
 * Detect the EXACT failure shape tool-executor returns for a non-floor tool
 * that errored without throwing: `JSON.stringify({ error: message })`. Match
 * is strict (a single `error` string key) so a tool that legitimately
 * returns an `error` field alongside real data is NOT mistaken for a
 * failure. Returns the message, or null if the result is a normal success.
 */
function extractSwallowedToolError(result: string): string | null {
  if (typeof result !== "string" || !result.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    if (
      parsed &&
      typeof parsed === "object" &&
      Object.keys(parsed).length === 1 &&
      typeof parsed.error === "string" &&
      parsed.error.length > 0
    ) {
      return parsed.error;
    }
  } catch {
    // not JSON — a normal string result
  }
  return null;
}

interface OutboxRowInput {
  pendingActionId: string;
  userId: string;
  conversationId?: string | null;
  toolName: string;
  toolArgs: unknown;
  actionReceipt: ActionReceipt | null;
  maxAttempts?: number;
}

/**
 * Insert the outbox row for an approved action. Call INSIDE the same
 * transaction (`tx`) that claims the PendingAction, so intent and claim
 * commit atomically. The caller's CAS (PENDING→EXECUTED returning count 0)
 * prevents a second concurrent approve from ever reaching this — and the
 * UNIQUE(pendingActionId) constraint is the backstop if it somehow did
 * (the txn would roll back rather than double-enqueue).
 */
export async function enqueueAction(
  tx: { actionOutbox: { create: (a: unknown) => Promise<unknown> } },
  input: OutboxRowInput,
): Promise<void> {
  await tx.actionOutbox.create({
    data: {
      pendingActionId: input.pendingActionId,
      userId: input.userId,
      conversationId: input.conversationId ?? undefined,
      toolName: input.toolName,
      toolArgs: input.toolArgs as object,
      actionReceipt: (input.actionReceipt as object | null) ?? undefined,
      idempotencyKey: deriveIdempotencyKey(input.pendingActionId, input.toolName, input.toolArgs),
      status: "QUEUED",
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    },
  });
}

export type AttemptOutcome =
  | { kind: "completed"; result: string }
  | { kind: "retry"; error: string; nextAttemptAt: Date }
  | { kind: "dead"; error: string }
  | { kind: "lost" }; // another worker/the inline path already claimed it

/**
 * Claim a row and run one attempt. The CAS claim (QUEUED → IN_PROGRESS) is
 * the single gate that makes execution at-most-once-per-attempt across the
 * inline fast-path AND the background worker: whoever flips QUEUED first
 * runs it; the loser gets {kind:"lost"}. This is the ONLY public way to
 * execute a row.
 */
export async function claimAndRunOutboxRow(
  row: OutboxRow,
  now: Date = new Date(),
): Promise<AttemptOutcome> {
  // attemptNo is computed ONCE here (1-based) and threaded through, so the
  // claim CAS and the terminal write agree on the same number without
  // re-reading row.attempts after the claim.
  const attemptNo = row.attempts + 1;
  const claim = await db.actionOutbox.updateMany({
    where: { id: row.id, status: "QUEUED" },
    data: { status: "IN_PROGRESS", attempts: attemptNo },
  });
  if (claim.count === 0) return { kind: "lost" };
  return runOutboxAttempt(row, attemptNo, now);
}

export type OutboxFailureCategory = "transient" | "transient-exhausted" | "permanent";

/**
 * Structured `lastError` for an outbox row, so an operator reading a DEAD or
 * QUEUED row sees WHY it failed and HOW far it got — not just a bare message
 * fragment. "transient" = will retry; "transient-exhausted" = retryable but out
 * of attempts; "permanent" = not retryable.
 */
export function formatOutboxError(props: {
  category: OutboxFailureCategory;
  attemptNo: number;
  maxAttempts: number;
  message: string;
}): string {
  return `[${props.category}] attempt ${props.attemptNo}/${props.maxAttempts}: ${props.message}`;
}

/**
 * Execute ONE attempt of an already-claimed row and persist its outcome.
 * `attemptNo` (1-based) is THIS attempt's number, matching what the claim
 * CAS wrote. On transient failure: reschedule with backoff, or DEAD if this
 * was the last allowed attempt. On permanent failure: DEAD immediately.
 * Always resolves — never throws.
 */
async function runOutboxAttempt(
  row: OutboxRow,
  attemptNo: number,
  now: Date,
): Promise<AttemptOutcome> {
  try {
    const receipt = (row.actionReceipt as ActionReceipt | null) ?? null;
    const args = (
      typeof row.toolArgs === "string" ? JSON.parse(row.toolArgs) : row.toolArgs
    ) as Record<string, unknown>;
    const result = await executeToolCall(row.userId, row.toolName, args, receipt);

    // tool-executor swallows non-floor tool failures and returns them as a
    // `{"error":"..."}` string instead of throwing (tool-executor.ts). If the
    // outbox treated that as success, a create_event that hit a 503 would be
    // recorded COMPLETED and never retried — a hollow durability promise. So
    // surface that shape as a failure and run it through the same classifier
    // (transient → retry, anything else → dead). Floor actions still throw,
    // so this only catches the non-floor swallowed case.
    const toolError = extractSwallowedToolError(result);
    if (toolError) throw new Error(toolError);

    await db.actionOutbox.update({
      where: { id: row.id },
      data: {
        status: "COMPLETED",
        attempts: attemptNo,
        result,
        lastError: null,
        completedAt: now,
      },
    });
    await onOutboxCompleted(row, result);
    return { kind: "completed", result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const transient = isTransientToolError(err);
    const canRetry = transient && attemptNo < row.maxAttempts;

    if (canRetry) {
      const nextAttemptAt = new Date(now.getTime() + backoffMs(attemptNo));
      await db.actionOutbox.update({
        where: { id: row.id },
        data: {
          status: "QUEUED",
          attempts: attemptNo,
          lastError: formatOutboxError({
            category: "transient",
            attemptNo,
            maxAttempts: row.maxAttempts,
            message,
          }),
          nextAttemptAt,
        },
      });
      return { kind: "retry", error: message, nextAttemptAt };
    }

    await db.actionOutbox.update({
      where: { id: row.id },
      data: {
        status: "DEAD",
        attempts: attemptNo,
        lastError: formatOutboxError({
          category: transient ? "transient-exhausted" : "permanent",
          attemptNo,
          maxAttempts: row.maxAttempts,
          message,
        }),
        completedAt: now,
      },
    });
    await onOutboxDead(row, message);
    return { kind: "dead", error: message };
  }
}

/**
 * Drain due outbox rows. Each row is claimed with an atomic CAS
 * (QUEUED → IN_PROGRESS, attempts incremented) so that concurrent workers —
 * or the inline fast-path racing the worker — can never execute the same row
 * twice. Runs under the scheduler's cross-worker lock already, so this is
 * belt-and-suspenders. Returns counts for observability.
 */
export async function drainActionOutbox(now: Date = new Date()): Promise<{
  completed: number;
  retried: number;
  dead: number;
  claimed: number;
  reclaimed: number;
}> {
  // Reclaim rows orphaned IN_PROGRESS by a crashed worker so they aren't
  // stranded. Reset to QUEUED (eligible now); attempts already counted.
  const staleCutoff = new Date(now.getTime() - STALE_IN_PROGRESS_MS);
  const reclaim = await db.actionOutbox.updateMany({
    where: { status: "IN_PROGRESS", updatedAt: { lte: staleCutoff } },
    data: { status: "QUEUED", nextAttemptAt: now },
  });

  const due = (await db.actionOutbox.findMany({
    where: { status: "QUEUED", nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: "asc" },
    take: DRAIN_BATCH,
  })) as OutboxRow[];

  let completed = 0;
  let retried = 0;
  let dead = 0;
  let claimed = 0;

  for (const row of due) {
    try {
      const outcome = await claimAndRunOutboxRow(row, now);
      if (outcome.kind === "lost") continue; // raced with the inline path / another worker
      claimed++;
      if (outcome.kind === "completed") completed++;
      else if (outcome.kind === "retry") retried++;
      else dead++;
    } catch (err) {
      // claimAndRunOutboxRow swallows tool errors, so reaching here means an
      // infra failure (DB write). Reset to QUEUED with backoff so the row
      // isn't stranded IN_PROGRESS forever. row.attempts is the pre-claim
      // snapshot, so row.attempts+1 is the attempt that just ran — its
      // attempts counter was already advanced by the claim CAS, so this can't
      // loop past maxAttempts.
      captureError(err, { tags: { scope: "action-outbox.drain" }, extra: { rowId: row.id } });
      await db.actionOutbox
        .update({
          where: { id: row.id },
          data: {
            status: "QUEUED",
            nextAttemptAt: new Date(now.getTime() + backoffMs(row.attempts + 1)),
          },
        })
        .catch((err) =>
          console.warn("[OUTBOX] reset-to-QUEUED after infra failure also failed:", err),
        );
    }
  }

  return { completed, retried, dead, claimed, reclaimed: reclaim.count ?? 0 };
}

// ── Completion side-effects (shared by inline fast-path and worker) ─────────
// Execution can complete in the request (fast path) or minutes later in the
// worker; either way the PendingAction writeback + chat message + realtime
// nudge must happen exactly once, here.

async function onOutboxCompleted(row: OutboxRow, result: string): Promise<void> {
  try {
    await db.pendingAction.update({ where: { id: row.pendingActionId }, data: { result } });
    const conversationId = await conversationIdFor(row);
    if (conversationId) {
      await db.message.create({
        data: {
          conversationId,
          role: "ASSISTANT",
          content: `${row.toolName.replace(/_/g, " ")} completed.`,
          metadata: { source: "agent", actionResult: true },
        },
      });
    }
    pushNotification(row.userId, {
      id: "action-executed",
      type: "system",
      title: "conversations-updated",
      message: "",
      createdAt: new Date().toISOString(),
    });
    import("./learning/pattern-learner.js")
      .then(({ learnFromApproval }) =>
        learnFromApproval(row.userId, row.toolName, asRecord(row.toolArgs)),
      )
      .catch((err) => {
        console.warn(`[OUTBOX] learnFromApproval failed for ${row.toolName}:`, err);
        captureError(err, { tags: { scope: "action-outbox.learn" }, extra: { rowId: row.id } });
      });
    // APPROVED feedback fires on successful execution (mutually exclusive
    // with the FAILED signal in onOutboxDead), matching the pre-outbox
    // coupling — so a transient-failed-then-retried action records exactly
    // one terminal signal, not a conflicting APPROVED+FAILED pair.
    const { recordFeedback, recipientFromToolArgs } = await import("./learning/feedback.js");
    await recordFeedback({
      userId: row.userId,
      source: "PENDING_ACTION",
      sourceId: row.pendingActionId,
      signal: "APPROVED",
      toolName: row.toolName,
      recipient: recipientFromToolArgs(row.toolArgs),
      threadId: (await conversationIdFor(row)) ?? row.pendingActionId,
    });
  } catch (err) {
    console.error(`[OUTBOX] onOutboxCompleted side-effects failed for row ${row.id}:`, err);
    captureError(err, { tags: { scope: "action-outbox.completed" }, extra: { rowId: row.id } });
  }
}

async function onOutboxDead(row: OutboxRow, error: string): Promise<void> {
  try {
    await db.pendingAction.update({
      where: { id: row.pendingActionId },
      data: { status: "FAILED", result: error },
    });
    const { upsertAttentionForPendingAction } = await import("./attention-mirror.js");
    const pa = (await db.pendingAction.findUnique({ where: { id: row.pendingActionId } })) as {
      id: string;
      userId: string;
      toolName: string;
      status: string;
      reasoning: string | null;
    } | null;
    if (pa) await upsertAttentionForPendingAction(pa);
    const conversationId = await conversationIdFor(row);
    if (conversationId) {
      await db.message.create({
        data: {
          conversationId,
          role: "ASSISTANT",
          content: `Execution failed: ${error}`,
          metadata: { source: "agent", actionFailed: true },
        },
      });
    }
    const { recordFeedback, recipientFromToolArgs } = await import("./learning/feedback.js");
    await recordFeedback({
      userId: row.userId,
      source: "PENDING_ACTION",
      sourceId: row.pendingActionId,
      signal: "FAILED",
      toolName: row.toolName,
      recipient: recipientFromToolArgs(row.toolArgs),
      threadId: conversationId ?? row.pendingActionId,
      evidence: error,
    });
    pushNotification(row.userId, {
      id: "action-failed",
      type: "system",
      title: "conversations-updated",
      message: "",
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[OUTBOX] onOutboxDead side-effects failed for row ${row.id}:`, err);
    captureError(err, { tags: { scope: "action-outbox.dead" }, extra: { rowId: row.id } });
  }
}

async function conversationIdFor(row: OutboxRow): Promise<string | null> {
  if (row.conversationId) return row.conversationId;
  const pa = (await db.pendingAction.findUnique({
    where: { id: row.pendingActionId },
    select: { conversationId: true },
  })) as { conversationId: string } | null;
  return pa?.conversationId ?? null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
