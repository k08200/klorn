/**
 * MCP write audit — one McpWriteAudit row per write-tool call (step A2a of
 * docs/providers/unified-platform-plan.md).
 *
 * Contracts, on purpose different:
 *  - ALLOWED write: inserted as `attempted` BEFORE the tool runs; an insert
 *    failure propagates, so the caller refuses the call and every executed write
 *    has a row. Afterwards `settleWriteAudit` moves it to ok/error and never throws.
 *  - REFUSED write: best-effort and never throws, so it can never change the
 *    response a read key gets for a write tool. It does NOTHING while
 *    MCP_WRITE_TOOLS_ENABLED is off (flag off means no new side effect), and it
 *    is throttled to one row per (key, tool, reason) per window: a key holder
 *    can otherwise drive thousands of inserts a minute with JSON-RPC batches at
 *    the small production pool.
 *
 * No mail content is stored: `targetId` is an opaque message id and `argsHash`
 * is SHA-256 over the canonical JSON of the arguments, with guards so hostile
 * arguments can neither throw nor cost more than a bounded amount of hashing.
 * `argsHash` marks an argument object over 4 KB as oversize, so a tool whose
 * arguments can be that long and whose content matters (create_draft) also passes
 * a `bodyHash` of its own, and its settle carries the created draft's id and a hash
 * of the recipient: identities, never the text or the address.
 */

import crypto from "node:crypto";
import { mcpWriteToolsEnabled } from "../config.js";
import { prisma } from "../db.js";
import { captureError } from "../sentry.js";
import { stableStringify } from "../stable-json.js";

/** Longest id kept as targetId. Gmail ids are 16 hex chars; anything longer is not an id. */
export const MAX_TARGET_ID_LENGTH = 256;
const TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

/** Deepest container nesting hashed by content; deeper input hashes a fixed marker. */
export const MAX_ARGS_DEPTH = 32;
/** Largest canonical JSON (bytes) hashed by content; larger input hashes marker + length. */
export const MAX_HASHED_ARGS_BYTES = 4096;

const MARKER_TOO_DEEP = "klorn:mcp-args:too-deep";
const MARKER_OVERSIZE = "klorn:mcp-args:oversize";
const MARKER_UNHASHABLE = "klorn:mcp-args:unhashable";

/** One refused-audit row per (key, tool, reason) per window; the rest are dropped. */
export const REFUSED_AUDIT_WINDOW_MS = 60_000;

/** Why a call was refused or failed. Short codes, stored in `reason`.
 * `permission_denied` means the gate did not admit the tool for this key (read
 * key, flag off, or plan). */
export type McpAuditReason = "permission_denied" | "rate_limited" | "tool_error" | "exception";

/** How an allowed call ended. Anything but ok carries the reason. `tiers` is set_tier's
 * lane change (only when the lane actually changed), so the log can show it and a
 * later step can revert it. */
export type McpSettleVerdict =
  | { outcome: "ok"; tiers?: { from: string; to: string }; draft?: DraftIdentity }
  | { outcome: "error"; reason: "tool_error" | "exception" };

/** What identifies a created draft: the provider's draft id (id-shaped only) and SHA-256 hex of the lowercased recipient. */
export interface DraftIdentity {
  draftId: string | null;
  recipientHash: string;
}

export interface McpWriteAuditInput {
  userId: string;
  apiKeyId: string;
  tool: string;
  args: Record<string, unknown>;
}

/** An allowed write may also carry the SHA-256 of the content it is about to act on. */
export interface McpAllowedWriteInput extends McpWriteAuditInput {
  bodyHash?: string | null;
}

/** SHA-256 hex digest of `text`. */
export const sha256Hex = (text: string): string =>
  crypto.createHash("sha256").update(text).digest("hex");

/** True when a container is nested deeper than the bound. Recursion stops at the bound. */
function exceedsDepth(value: unknown, depth = 0): boolean {
  if (value === null || typeof value !== "object") return false;
  if (depth >= MAX_ARGS_DEPTH) return true;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.some((child) => exceedsDepth(child, depth + 1));
}

/**
 * SHA-256 of the canonical JSON of the arguments. Never throws. Deeper than
 * MAX_ARGS_DEPTH hashes a fixed marker; a canonical JSON over MAX_HASHED_ARGS_BYTES
 * hashes a marker plus its byte length (the content is deliberately not hashed);
 * a value JSON cannot carry (BigInt) hashes its own marker.
 */
export function hashToolArgs(args: Record<string, unknown>): string {
  try {
    if (exceedsDepth(args)) return sha256Hex(MARKER_TOO_DEEP);
    const canonical = stableStringify(args);
    const bytes = Buffer.byteLength(canonical, "utf8");
    if (bytes > MAX_HASHED_ARGS_BYTES) return sha256Hex(`${MARKER_OVERSIZE}:${bytes}`);
    return sha256Hex(canonical);
  } catch {
    return sha256Hex(MARKER_UNHASHABLE);
  }
}

/** `value` when it is an id-shaped string (1-256 of [A-Za-z0-9_-]), else null. NUL
 * bytes, spaces and non-ASCII never reach the database. */
export function auditIdOf(value: unknown): string | null {
  return typeof value === "string" && TARGET_ID_PATTERN.test(value) ? value : null;
}

/** The message id a write call names, only if it is id-shaped. */
function targetIdOf(args: Record<string, unknown>): string | null {
  return auditIdOf(args.email_id);
}

function rowData(
  input: McpWriteAuditInput,
  outcome: "attempted" | "refused",
  reason: McpAuditReason | null,
) {
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

/** Failure context for Sentry: who, through which key, doing what. */
function failureExtra(input: McpWriteAuditInput, more: Record<string, unknown> = {}) {
  return { userId: input.userId, apiKeyId: input.apiKeyId, tool: input.tool, ...more };
}

/**
 * Insert the row for a write that is about to run, as `attempted`, and return
 * its id. Throws on failure: the caller must refuse the call, never execute it
 * un-audited.
 */
export async function recordAllowedWrite(input: McpAllowedWriteInput): Promise<string> {
  const row = await prisma.mcpWriteAudit.create({
    data: {
      ...rowData(input, "attempted", null),
      ...(input.bodyHash ? { bodyHash: input.bodyHash } : {}),
    },
    select: { id: true },
  });
  return row.id;
}

/** Move a pre-inserted row to its final outcome. Never throws: on failure the
 * row stays `attempted`, which honestly reads "outcome unknown". */
export async function settleWriteAudit(
  input: McpWriteAuditInput,
  auditId: string,
  verdict: McpSettleVerdict,
): Promise<void> {
  try {
    await prisma.mcpWriteAudit.update({
      where: { id: auditId },
      data: {
        outcome: verdict.outcome,
        reason: verdict.outcome === "error" ? verdict.reason : null,
        ...(verdict.outcome === "ok" && verdict.tiers
          ? { tierFrom: verdict.tiers.from, tierTo: verdict.tiers.to }
          : {}),
        ...(verdict.outcome === "ok" && verdict.draft
          ? { draftId: verdict.draft.draftId, recipientHash: verdict.draft.recipientHash }
          : {}),
      },
    });
  } catch (err) {
    captureError(err, {
      tags: { scope: "mcp.write-audit.settle" },
      extra: failureExtra(input, { auditId }),
    });
  }
}

/** Last recorded time (ms) per "apiKeyId|tool|reason", and the last idle sweep. */
const lastRefusedRecordAt = new Map<string, number>();
let lastThrottleSweepAt = 0;
let droppedRefusedAudits = 0;

/** Refused rows dropped by the throttle since boot — a cheap in-memory counter. */
export function droppedRefusedAuditCount(): number {
  return droppedRefusedAudits;
}

/** Claim this window's row for (key, tool, reason). False means drop the audit. */
function claimRefusedSlot(input: McpWriteAuditInput, reason: McpAuditReason, now: number): boolean {
  if (now - lastThrottleSweepAt >= REFUSED_AUDIT_WINDOW_MS) {
    for (const [key, at] of lastRefusedRecordAt) {
      if (now - at >= REFUSED_AUDIT_WINDOW_MS) lastRefusedRecordAt.delete(key);
    }
    lastThrottleSweepAt = now;
  }
  const key = `${input.apiKeyId}|${input.tool}|${reason}`;
  const last = lastRefusedRecordAt.get(key);
  if (last !== undefined && now - last < REFUSED_AUDIT_WINDOW_MS) {
    droppedRefusedAudits += 1;
    return false;
  }
  lastRefusedRecordAt.set(key, now);
  return true;
}

/** Best-effort row for a refused write. Never throws; a no-op while the flag is off. */
export async function recordRefusedWrite(
  input: McpWriteAuditInput & { reason: McpAuditReason },
): Promise<void> {
  if (!mcpWriteToolsEnabled()) return;
  if (!claimRefusedSlot(input, input.reason, Date.now())) return;
  try {
    await prisma.mcpWriteAudit.create({
      data: rowData(input, "refused", input.reason),
      select: { id: true },
    });
  } catch (err) {
    captureError(err, {
      tags: { scope: "mcp.write-audit.refused" },
      extra: failureExtra(input),
    });
  }
}
