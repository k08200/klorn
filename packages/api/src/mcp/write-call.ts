/**
 * Running one MCP write-tool call (step A2a). Only reached for a tool in the
 * write set that the gate ADMITTED for this key; a refused write never gets
 * here (server.ts audits it best-effort and answers "Unknown tool").
 *
 * Order matters:
 *  1. per-user cap — over it, refuse with an explicit rate-limit error. The
 *     caller already has a working write tool, so this reveals nothing.
 *  2. audit insert — BEFORE execution, and a failed insert refuses the call:
 *     no write ever runs without a row.
 *  3. execute — a thrown error, or the executor's in-band {"error"} failure
 *     shape, downgrades the row to outcome=error. The response itself is
 *     never altered by the audit.
 */

import { executeToolCall } from "../agentcore/tool-executor.js";
import { captureError } from "../sentry.js";
import { errorResult, type McpToolResult, textResult } from "./tool-result.js";
import { recordAllowedWrite, recordRefusedWrite, settleWriteAudit } from "./write-audit.js";
import { consumeMcpWriteBudget } from "./write-rate-cap.js";

const RATE_LIMITED_MESSAGE = "Too many write actions — try again in a minute.";
const AUDIT_UNAVAILABLE_MESSAGE =
  "Write not performed: the audit log is unavailable. Nothing was changed.";

export interface McpWriteCall {
  userId: string;
  apiKeyId: string;
  name: string;
  args: Record<string, unknown>;
}

/** executeToolCall reports failures as a JSON string with a string `error` key. */
function isInBandFailure(result: string): boolean {
  try {
    const parsed: unknown = JSON.parse(result);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { error?: unknown }).error === "string"
    );
  } catch {
    return false;
  }
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
    captureError(err, { tags: { scope: "mcp.write-audit.insert" }, extra: { userId, tool: name } });
    return errorResult(AUDIT_UNAVAILABLE_MESSAGE);
  }

  try {
    const result = await executeToolCall(userId, name, args);
    if (isInBandFailure(result)) await settleWriteAudit(auditId, "tool_error");
    return textResult(result);
  } catch (err) {
    await settleWriteAudit(auditId, "exception");
    return errorResult(err instanceof Error ? err.message : "Tool failed.");
  }
}
