/**
 * MCP write audit — one McpWriteAudit row per write-tool call, refused calls
 * included (step A2a of docs/providers/unified-platform-plan.md).
 *
 * Two different failure contracts, on purpose:
 *  - ALLOWED write: the row is inserted BEFORE the tool runs and an insert
 *    failure propagates, so the caller refuses the call. Every write that
 *    executes therefore has a row.
 *  - REFUSED write: best-effort. It never throws, so it can never change the
 *    response a read key gets for a write tool.
 *
 * No mail content is stored: `targetId` is an opaque message id and `argsHash`
 * is SHA-256 over the canonical JSON of the arguments.
 */

import crypto from "node:crypto";
import { prisma } from "../db.js";
import { captureError } from "../sentry.js";

/** Longest id kept as targetId. Gmail ids are 16 hex chars; anything longer is not an id. */
export const MAX_TARGET_ID_LENGTH = 256;

/** Why a call was refused or failed. Short codes, stored in `reason`. */
export type McpAuditReason = "permission_denied" | "rate_limited" | "tool_error" | "exception";

export interface McpWriteAuditInput {
  userId: string;
  apiKeyId: string;
  tool: string;
  args: Record<string, unknown>;
}

/** JSON with object keys sorted at every depth, so equal arguments hash equally. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const body = Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
  return `{${body.join(",")}}`;
}

export function hashToolArgs(args: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(canonicalJson(args)).digest("hex");
}

/** The message id a write call names, if it names one that looks like an id. */
function targetIdOf(args: Record<string, unknown>): string | null {
  const id = args.email_id;
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_TARGET_ID_LENGTH ? trimmed : null;
}

function rowData(input: McpWriteAuditInput, outcome: "ok" | "refused", reason: string | null) {
  return {
    userId: input.userId,
    apiKeyId: input.apiKeyId,
    tool: input.tool,
    targetId: targetIdOf(input.args),
    argsHash: hashToolArgs(input.args),
    outcome,
    reason,
  };
}

/**
 * Insert the row for a write that is about to run and return its id. Throws on
 * failure: the caller must refuse the call, never execute it un-audited.
 */
export async function recordAllowedWrite(input: McpWriteAuditInput): Promise<string> {
  const row = await prisma.mcpWriteAudit.create({
    data: rowData(input, "ok", null),
    select: { id: true },
  });
  return row.id;
}

/** Best-effort row for a refused write. Never throws. */
export async function recordRefusedWrite(
  input: McpWriteAuditInput & { reason: McpAuditReason },
): Promise<void> {
  try {
    await prisma.mcpWriteAudit.create({
      data: rowData(input, "refused", input.reason),
      select: { id: true },
    });
  } catch (err) {
    captureError(err, { tags: { scope: "mcp.write-audit.refused" }, extra: { tool: input.tool } });
  }
}

/** Downgrade a pre-inserted row to outcome=error after the tool failed. Never throws. */
export async function settleWriteAudit(auditId: string, reason: McpAuditReason): Promise<void> {
  try {
    await prisma.mcpWriteAudit.update({
      where: { id: auditId },
      data: { outcome: "error", reason },
    });
  } catch (err) {
    captureError(err, { tags: { scope: "mcp.write-audit.settle" }, extra: { auditId } });
  }
}
