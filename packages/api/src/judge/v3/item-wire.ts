/**
 * The `v3` block on list items, firewall items and the Reader context
 * (docs/design/attention-engine-v3.md §3(5) "Reasons and API contract"). Pure:
 * readers select the stored columns and map them here. Stored JSON is
 * re-validated, never passed through.
 */

import type { V3ItemBlock } from "@klorn/contract";
import { toLiveTier } from "../tiers.js";
import { THREAD_TURNS, type ThreadTurn } from "./facts-schema.js";
import { POLICY_VERSION, V2_POLICY_VERSION } from "./policy.js";
import {
  type ApiReason,
  type PolicyReason,
  REASON_CODES,
  type ReasonCode,
  type ReasonParamValue,
  reason,
  withEvidenceLocation,
} from "./reasons.js";

/** The AttentionItem columns the block is built from. */
export interface V3ItemRow {
  tier: string | null;
  heldAt: Date | null;
  isManualOverride: boolean;
  agentTierSetAt: Date | null;
  v3PolicyVersion: string | null;
  v3Decision: unknown;
  v3Due: Date | null;
}

/** Prisma select for V3ItemRow. */
export const V3_ITEM_SELECT = {
  tier: true,
  heldAt: true,
  isManualOverride: true,
  agentTierSetAt: true,
  v3PolicyVersion: true,
  v3Decision: true,
  v3Due: true,
} as const;

/** The wire block (`@klorn/contract` V3ItemBlock). */
export type V3ItemWire = V3ItemBlock;

const MAX_EVIDENCE_CHARS = 300;
const MAX_REASONS = 12;
const POLICY_VERSIONS = new Set<string>([POLICY_VERSION, V2_POLICY_VERSION]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Held as clients see it: the budget held the item and it still shows that.
 * Not once a human or an agent set the lane, or the lane is no longer QUEUE.
 */
export function isShownHeld(row: V3ItemRow): boolean {
  return (
    row.heldAt !== null &&
    toLiveTier(row.tier) === "QUEUE" &&
    !row.isManualOverride &&
    row.agentTierSetAt === null
  );
}

export function v3ItemWire(
  row: V3ItemRow,
  opts: { rank: number | null; subject: string | null },
): V3ItemWire {
  const decision = isRecord(row.v3Decision) ? row.v3Decision : null;
  return {
    policyVersion:
      row.v3PolicyVersion && POLICY_VERSIONS.has(row.v3PolicyVersion) ? row.v3PolicyVersion : null,
    rank: opts.rank,
    held: isShownHeld(row),
    due: row.v3Due ? row.v3Due.toISOString() : null,
    threadTurn: parseThreadTurn(decision?.threadTurn),
    reasons: reasonsFor(row, decision).map((r) => withEvidenceLocation(r, opts.subject)),
  };
}

function reasonsFor(row: V3ItemRow, decision: Record<string, unknown> | null): PolicyReason[] {
  if (row.isManualOverride) {
    return [reason("manual_override", { params: { tier: toLiveTier(row.tier) } })];
  }
  if (row.agentTierSetAt !== null) return [];
  const raw = Array.isArray(decision?.reasons) ? decision.reasons : [];
  return raw.slice(0, MAX_REASONS).flatMap((r) => {
    const parsed = parseReason(r);
    return parsed ? [parsed] : [];
  });
}

function parseThreadTurn(value: unknown): ThreadTurn | null {
  return typeof value === "string" && (THREAD_TURNS as readonly string[]).includes(value)
    ? (value as ThreadTurn)
    : null;
}

function parseReason(raw: unknown): PolicyReason | null {
  if (!isRecord(raw)) return null;
  const { code } = raw;
  if (typeof code !== "string" || !(REASON_CODES as readonly string[]).includes(code)) return null;
  return reason(code as ReasonCode, {
    fact: typeof raw.fact === "string" ? raw.fact : null,
    evidence: typeof raw.evidence === "string" ? raw.evidence.slice(0, MAX_EVIDENCE_CHARS) : null,
    params: parseParams(raw.params),
  });
}

const isParamValue = (value: unknown): value is ReasonParamValue =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

function parseParams(raw: unknown): Record<string, ReasonParamValue> {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter(([, value]) => isParamValue(value)),
  ) as Record<string, ReasonParamValue>;
}
