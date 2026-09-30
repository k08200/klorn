/**
 * Running one MCP write-tool call (step A2a). Only reached for a tool in the
 * write set that the gate ADMITTED for this key; a refused write never gets
 * here (server.ts audits it best-effort and answers "Unknown tool").
 *
 * Order matters:
 *  1. per-user cap — over it, refuse with an explicit rate-limit error. The
 *     caller already has a working write tool, so this reveals nothing.
 *  2. audit insert as `attempted` — BEFORE execution, and a failed insert
 *     refuses the call: no write ever runs without a row.
 *  3. execute, then settle the row: `ok` only when the tool's own success
 *     predicate holds, `error` for a thrown error or any other result. The
 *     response is never altered by the audit.
 */

import { executeToolCall } from "../agentcore/tool-executor.js";
import { captureError } from "../sentry.js";
import { executeSetTier, SET_TIER_TOOL_NAME } from "./set-tier.js";
import { errorResult, type McpToolResult, textResult } from "./tool-result.js";
import { recordAllowedWrite, recordRefusedWrite, settleWriteAudit } from "./write-audit.js";

const RATE_LIMITED_MESSAGE = "Too many write actions — try again in a minute.";
const AUDIT_UNAVAILABLE_MESSAGE =
  "Write not performed: the audit log is unavailable. Nothing was changed.";

/** Allowed write calls per user per window. Proposed value, no measurement behind it. */
export const MCP_WRITE_CAP_PER_WINDOW = 30;
export const MCP_WRITE_WINDOW_MS = 60_000;

/** Timestamps (ms) of each user's counted writes inside the window. Replaced, never mutated. */
const writesByUser = new Map<string, readonly number[]>();
let lastBudgetSweepAt = 0;

/** Drop users whose newest counted write has left the window, so idle users do not accumulate. */
function sweepIdleUsers(now: number): void {
  for (const [userId, times] of writesByUser) {
    const newest = times.at(-1);
    if (newest === undefined || now - newest >= MCP_WRITE_WINDOW_MS) writesByUser.delete(userId);
  }
  lastBudgetSweepAt = now;
}

/** Users currently holding a window entry (observability and the idle-sweep test). */
export function trackedWriteBudgetUsers(): number {
  return writesByUser.size;
}

/**
 * Spend one write from `userId`'s budget — a sliding window per USER, never per
 * key: a user may hold several keys and five keys must not multiply the number
 * of mailbox changes an agent can make. Returns false, recording nothing, when
 * the window already holds the cap (a refused call must not extend the lockout).
 *
 * In-process, so the cap is PER INSTANCE: with N instances behind the load
 * balancer the ceiling is up to N x the constant. Same trade-off as the
 * team_availability budget in agentcore/tool-executor.ts, which this follows.
 */
export function consumeMcpWriteBudget(userId: string, now: number = Date.now()): boolean {
  if (now - lastBudgetSweepAt >= MCP_WRITE_WINDOW_MS) sweepIdleUsers(now);
  const recent = (writesByUser.get(userId) ?? []).filter((t) => now - t < MCP_WRITE_WINDOW_MS);
  if (recent.length >= MCP_WRITE_CAP_PER_WINDOW) {
    writesByUser.set(userId, recent);
    return false;
  }
  writesByUser.set(userId, [...recent, now]);
  return true;
}

/**
 * Per-tool "did it work" predicate over the parsed tool result. A new write tool
 * must add its own (mcp-tool-gate.test.ts pins that every member has one); a tool
 * without one never settles to ok.
 */
const hasSuccessTrue = (parsed: unknown): boolean =>
  typeof parsed === "object" &&
  parsed !== null &&
  !Array.isArray(parsed) &&
  (parsed as { success?: unknown }).success === true;

export const WRITE_TOOL_SUCCESS: Readonly<Record<string, (parsed: unknown) => boolean>> = {
  mark_read: hasSuccessTrue,
  [SET_TIER_TOOL_NAME]: hasSuccessTrue,
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

/** set_tier is MCP-only and has its own executor; everything else shares the chat/agent one. */
function executeWriteTool(call: McpWriteCall): Promise<string> {
  const { userId, apiKeyId, name, args } = call;
  if (name === SET_TIER_TOOL_NAME) return executeSetTier({ userId, apiKeyId }, args);
  return executeToolCall(userId, name, args);
}

export async function runMcpWriteCall(call: McpWriteCall): Promise<McpToolResult> {
  const { userId, apiKeyId, name, args } = call;
  const audit = { userId, apiKeyId, tool: name, args };

  if (!consumeMcpWriteBudget(userId)) {
    void recordRefusedWrite({ ...audit, reason: "rate_limited" });
    return errorResult(RATE_LIMITED_MESSAGE, { code: "RATE_LIMITED" });
  }

  let auditId: string;
  try {
    auditId = await recordAllowedWrite(audit);
  } catch (err) {
    captureError(err, {
      tags: { scope: "mcp.write-audit.insert" },
      extra: { userId, apiKeyId, tool: name },
    });
    return errorResult(AUDIT_UNAVAILABLE_MESSAGE);
  }

  try {
    const result = await executeWriteTool(call);
    await settleWriteAudit(
      audit,
      auditId,
      isWriteSuccess(name, result) ? { outcome: "ok" } : { outcome: "error", reason: "tool_error" },
    );
    return textResult(result);
  } catch (err) {
    await settleWriteAudit(audit, auditId, { outcome: "error", reason: "exception" });
    return errorResult(err instanceof Error ? err.message : "Tool failed.");
  }
}
