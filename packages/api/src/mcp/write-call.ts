/**
 * Running one MCP write-tool call (step A2a). Only reached for a tool in the
 * write set that the gate ADMITTED for this key; a refused write never gets
 * here (server.ts audits it best-effort and answers "Unknown tool").
 *
 * Order matters:
 *  1. per-user cap — over it, refuse with an explicit rate-limit error. The
 *     caller already has a working write tool, so this reveals nothing. A tool
 *     with its own lower cap (create_draft) is also held to that one.
 *  2. audit insert as `attempted` — BEFORE execution, and a failed insert
 *     refuses the call: no write ever runs without a row.
 *  3. execute, then settle the row: `ok` only when the tool's own success
 *     predicate holds, `error` for a thrown error or any other result. The
 *     response is never altered by the audit.
 */

import { executeToolCall } from "../agentcore/tool-executor.js";
import { captureError } from "../sentry.js";
import {
  CREATE_DRAFT_TOOL_NAME,
  createdDraftIdentity,
  draftBodyHash,
  executeCreateDraft,
} from "./create-draft.js";
import { changedLanes, executeSetTier, SET_TIER_TOOL_NAME } from "./set-tier.js";
import { errorResult, type McpToolResult, textResult } from "./tool-result.js";
import {
  type McpSettleVerdict,
  recordAllowedWrite,
  recordRefusedWrite,
  settleWriteAudit,
} from "./write-audit.js";

const RATE_LIMITED_MESSAGE = "Too many write actions — try again in a minute.";
const DRAFT_RATE_LIMITED_MESSAGE = "Too many drafts — try again in a minute.";
const AUDIT_UNAVAILABLE_MESSAGE =
  "Write not performed: the audit log is unavailable. Nothing was changed.";

/** Allowed write calls per user per window. Proposed value, no measurement behind it. */
export const MCP_WRITE_CAP_PER_WINDOW = 30;
export const MCP_WRITE_WINDOW_MS = 60_000;
/**
 * Drafts per user per window, on top of the shared cap: each one leaves a message in
 * the user's mailbox, so a runaway agent should hit this long before the shared 30.
 * Proposed value, no measurement behind it.
 */
export const MCP_CREATE_DRAFT_CAP_PER_WINDOW = 10;

/** Tools held to a cap of their own, in addition to the shared one. */
const TOOL_CAPS: Readonly<Record<string, number>> = {
  [CREATE_DRAFT_TOOL_NAME]: MCP_CREATE_DRAFT_CAP_PER_WINDOW,
};

/** Timestamps (ms) of each user's counted writes inside the window. Replaced, never mutated. */
const writesByUser = new Map<string, readonly number[]>();
/** The same per (user, tool), for the tools in TOOL_CAPS only. */
const writesByUserTool = new Map<string, readonly number[]>();
let lastBudgetSweepAt = 0;

const toolBudgetKey = (userId: string, tool: string): string => `${userId}|${tool}`;

/** Drop users whose newest counted write has left the window, so idle users do not accumulate. */
function sweepIdle(windows: Map<string, readonly number[]>, now: number): void {
  for (const [key, times] of windows) {
    const newest = times.at(-1);
    if (newest === undefined || now - newest >= MCP_WRITE_WINDOW_MS) windows.delete(key);
  }
}

function sweepIdleUsers(now: number): void {
  sweepIdle(writesByUser, now);
  sweepIdle(writesByUserTool, now);
  lastBudgetSweepAt = now;
}

const withinWindow = (times: readonly number[] | undefined, now: number): readonly number[] =>
  (times ?? []).filter((t) => now - t < MCP_WRITE_WINDOW_MS);

/** Users currently holding a window entry (observability and the idle-sweep test). */
export function trackedWriteBudgetUsers(): number {
  return writesByUser.size;
}

/**
 * Spend one write from `userId`'s budget — a sliding window per USER, never per
 * key: a user may hold several keys and five keys must not multiply the number
 * of mailbox changes an agent can make. A tool with its own cap (`tool` in
 * TOOL_CAPS) must fit that window too. Returns false, recording NOTHING in either
 * window, when a window already holds its cap (a refused call must not extend the
 * lockout, and a draft refused by its own cap must not spend the shared budget).
 *
 * In-process, so the cap is PER INSTANCE: with N instances behind the load
 * balancer the ceiling is up to N x the constant. Same trade-off as the
 * team_availability budget in agentcore/tool-executor.ts, which this follows.
 */
export function consumeMcpWriteBudget(
  userId: string,
  now: number = Date.now(),
  tool?: string,
): boolean {
  if (now - lastBudgetSweepAt >= MCP_WRITE_WINDOW_MS) sweepIdleUsers(now);
  const shared = withinWindow(writesByUser.get(userId), now);
  const toolCap = tool === undefined ? undefined : TOOL_CAPS[tool];
  const toolKey = toolBudgetKey(userId, tool ?? "");
  const own = toolCap === undefined ? [] : withinWindow(writesByUserTool.get(toolKey), now);
  if (shared.length >= MCP_WRITE_CAP_PER_WINDOW) {
    writesByUser.set(userId, shared);
    return false;
  }
  if (toolCap !== undefined && own.length >= toolCap) {
    writesByUserTool.set(toolKey, own);
    return false;
  }
  writesByUser.set(userId, [...shared, now]);
  if (toolCap !== undefined) writesByUserTool.set(toolKey, [...own, now]);
  return true;
}

const hasSuccessTrue = (parsed: unknown): boolean =>
  typeof parsed === "object" &&
  parsed !== null &&
  !Array.isArray(parsed) &&
  (parsed as { success?: unknown }).success === true;

/**
 * Per-tool "did it work" predicate over the parsed tool result. A new write tool
 * must add its own (mcp-tool-gate.test.ts pins that every member has one); a tool
 * without one never settles to ok.
 */
export const WRITE_TOOL_SUCCESS: Readonly<Record<string, (parsed: unknown) => boolean>> = {
  mark_read: hasSuccessTrue,
  [SET_TIER_TOOL_NAME]: hasSuccessTrue,
  [CREATE_DRAFT_TOOL_NAME]: hasSuccessTrue,
};

/** Whether `resultText` is a success for `tool`. Non-JSON, arrays, in-band
 * {"error"} and {"unsupported"} results are all failures. */
export function isWriteSuccess(tool: string, resultText: string): boolean {
  const predicate = WRITE_TOOL_SUCCESS[tool];
  if (!predicate) return false;
  try {
    return predicate(JSON.parse(resultText));
  } catch {
    return false;
  }
}

export interface McpWriteCall {
  userId: string;
  apiKeyId: string;
  name: string;
  args: Record<string, unknown>;
}

/** set_tier and create_draft are MCP-only and have their own executors; everything else shares the chat/agent one. */
function executeWriteTool(call: McpWriteCall): Promise<string> {
  const { userId, apiKeyId, name, args } = call;
  if (name === SET_TIER_TOOL_NAME) return executeSetTier({ userId, apiKeyId }, args);
  if (name === CREATE_DRAFT_TOOL_NAME) return executeCreateDraft({ userId }, args);
  return executeToolCall(userId, name, args);
}

/**
 * How a finished call settles: ok only when the tool's own predicate holds;
 * set_tier adds its lane change and create_draft the draft's identity.
 */
function verdictFor(name: string, result: string): McpSettleVerdict {
  if (!isWriteSuccess(name, result)) return { outcome: "error", reason: "tool_error" };
  if (name === SET_TIER_TOOL_NAME) {
    const tiers = changedLanes(result);
    return tiers ? { outcome: "ok", tiers } : { outcome: "ok" };
  }
  if (name === CREATE_DRAFT_TOOL_NAME) {
    const draft = createdDraftIdentity(result);
    return draft ? { outcome: "ok", draft } : { outcome: "ok" };
  }
  return { outcome: "ok" };
}

/** SHA-256 of the content a write is about to act on, for the `attempted` row. Only create_draft has any. */
const contentHashFor = (name: string, args: Record<string, unknown>): string | null =>
  name === CREATE_DRAFT_TOOL_NAME ? draftBodyHash(args) : null;

export async function runMcpWriteCall(call: McpWriteCall): Promise<McpToolResult> {
  const { userId, apiKeyId, name, args } = call;
  const audit = { userId, apiKeyId, tool: name, args };

  if (!consumeMcpWriteBudget(userId, Date.now(), name)) {
    void recordRefusedWrite({ ...audit, reason: "rate_limited" });
    const message = name in TOOL_CAPS ? DRAFT_RATE_LIMITED_MESSAGE : RATE_LIMITED_MESSAGE;
    return errorResult(message, { code: "RATE_LIMITED" });
  }

  let auditId: string;
  try {
    auditId = await recordAllowedWrite({ ...audit, bodyHash: contentHashFor(name, args) });
  } catch (err) {
    captureError(err, {
      tags: { scope: "mcp.write-audit.insert" },
      extra: { userId, apiKeyId, tool: name },
    });
    return errorResult(AUDIT_UNAVAILABLE_MESSAGE);
  }

  try {
    const result = await executeWriteTool(call);
    await settleWriteAudit(audit, auditId, verdictFor(name, result));
    return textResult(result);
  } catch (err) {
    await settleWriteAudit(audit, auditId, { outcome: "error", reason: "exception" });
    return errorResult(err instanceof Error ? err.message : "Tool failed.");
  }
}
