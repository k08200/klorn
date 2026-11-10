/**
 * The `v3` block on list items, firewall items and the Reader context
 * (docs/design/attention-engine-v3.md §3(5) "Reasons and API contract"). Pure:
 * readers select the stored columns and map them here. Stored JSON is
 * re-validated, never passed through.
 */

import type { V3ItemBlock } from "@klorn/contract";
import { toLiveTier } from "../tiers.js";
import { cleanText, MAX_EVIDENCE_CHARS, THREAD_TURNS, type ThreadTurn } from "./facts-schema.js";
import {
  CLIENT_RELATIONSHIP_KEYS,
  POLICY_VERSIONS as POLICY_RULE_VERSIONS,
  V2_POLICY_VERSION,
} from "./policy.js";
import { HELD_WINDOW_MS } from "./ranking.js";
import {
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
  /** AttentionStatus: a hold shows only while the item is OPEN. */
  status: string;
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
  status: true,
  heldAt: true,
  isManualOverride: true,
  agentTierSetAt: true,
  v3PolicyVersion: true,
  v3Decision: true,
  v3Due: true,
} as const;

/** The wire block (`@klorn/contract` V3ItemBlock). */
export type V3ItemWire = V3ItemBlock;

/** A mail the judge has not reached yet (no item), or a row with columns missing. */
export const UNDECIDED_V3_ROW: V3ItemRow = {
  tier: null,
  status: "OPEN",
  heldAt: null,
  isManualOverride: false,
  agentTierSetAt: null,
  v3PolicyVersion: null,
  v3Decision: null,
  v3Due: null,
};

/** A full V3ItemRow from whatever a reader selected; missing columns decide nothing. */
export function toV3ItemRow(partial: Partial<V3ItemRow> | null | undefined): V3ItemRow {
  return { ...UNDECIDED_V3_ROW, ...(partial ?? {}) };
}

const MAX_FACT_CHARS = 64;
const MAX_PARAM_STRING_CHARS = 64;
const MAX_REASONS = 12;

/**
 * The params each reason code may carry to clients (doc §3(5) "Params by
 * code"). Anything else stored under a reason is dropped on read, so a stored
 * score or a future field never reaches a client by accident.
 */
const TIER_PARAMS = ["tier"] as const;
const PARAMS_BY_CODE: Readonly<Partial<Record<ReasonCode, readonly string[]>>> = {
  pinned: TIER_PARAMS,
  manual_override: TIER_PARAMS,
  sender_pattern: TIER_PARAMS,
  learned_rule: TIER_PARAMS,
  kind: ["kind", "tier"],
  addressed_to_me: ["addressedTo"],
  risk: ["risk", "trusted", "overBudget"],
  event: ["conflict"],
  ask: ["askKind", "due"],
  ask_due_soon: ["askKind", "due"],
  transaction_action: ["transactionKind"],
  transaction_record: ["transactionKind"],
  held_budget: ["budget"],
  relationship: CLIENT_RELATIONSHIP_KEYS,
};
/** Every version a stored decision may name: each policy version replay knows, and v2. */
const KNOWN_VERSIONS = new Set<string>([...POLICY_RULE_VERSIONS, V2_POLICY_VERSION]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Held as clients see it (and as the ranked SQL reads it): the budget held the
 * item within the last HELD_WINDOW_MS, and it still shows that: still OPEN,
 * still QUEUE (the stored tier exactly; a hold is only written with QUEUE), and
 * no human or agent lane on it. Done or Later mail, and yesterday's holds, rank
 * by score like any QUEUE mail.
 */
export function isShownHeld(row: V3ItemRow, now: Date): boolean {
  return (
    row.heldAt !== null &&
    row.heldAt.getTime() > now.getTime() - HELD_WINDOW_MS &&
    row.tier === "QUEUE" &&
    row.status === "OPEN" &&
    !row.isManualOverride &&
    row.agentTierSetAt === null
  );
}

export function v3ItemWire(
  row: V3ItemRow,
  opts: { rank: number | null; subject: string | null; now: Date },
): V3ItemWire {
  const decision = isRecord(row.v3Decision) ? row.v3Decision : null;
  const policyVersion =
    row.v3PolicyVersion && KNOWN_VERSIONS.has(row.v3PolicyVersion) ? row.v3PolicyVersion : null;
  return {
    policyVersion,
    rank: opts.rank,
    held: isShownHeld(row, opts.now),
    due: row.v3Due ? row.v3Due.toISOString() : null,
    threadTurn: parseThreadTurn(decision?.threadTurn),
    reasons: reasonsFor(row, decision, policyVersion).map((r) =>
      withEvidenceLocation(r, opts.subject),
    ),
  };
}

function reasonsFor(
  row: V3ItemRow,
  decision: Record<string, unknown> | null,
  policyVersion: string | null,
): PolicyReason[] {
  if (row.isManualOverride) {
    return [reason("manual_override", { params: { tier: toLiveTier(row.tier) } })];
  }
  // An agent's lane, or reasons from a version this server does not know
  // (a rollback), explain nothing.
  if (row.agentTierSetAt !== null || policyVersion === null) return [];
  const raw = Array.isArray(decision?.reasons) ? decision.reasons.slice(0, MAX_REASONS) : [];
  const parsed = raw.map(parseReason);
  // reasons[0] decides the lane: if it cannot be read, a supporting reason
  // must not take its place, so none are shown.
  if (parsed[0] === null) return [];
  return parsed.filter((r): r is PolicyReason => r !== null);
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
  const fact = cleanText(raw.fact, MAX_FACT_CHARS);
  // Evidence quotes the mail (attacker-authored): the write side's cleaning
  // again, which caps by code point (never splitting a surrogate pair) and
  // drops format and control characters.
  const evidence = cleanText(raw.evidence, MAX_EVIDENCE_CHARS);
  return reason(code as ReasonCode, {
    fact: fact || null,
    evidence: evidence || null,
    params: parseParams(code as ReasonCode, raw.params),
  });
}

const isParamValue = (value: unknown): value is ReasonParamValue =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

function parseParams(code: ReasonCode, raw: unknown): Record<string, ReasonParamValue> {
  if (!isRecord(raw)) return {};
  const allowed = PARAMS_BY_CODE[code] ?? [];
  return Object.fromEntries(
    allowed
      .filter((key) => key in raw && isParamValue(raw[key]))
      .map((key) => {
        const value = raw[key] as ReasonParamValue;
        return [key, typeof value === "string" ? cleanText(value, MAX_PARAM_STRING_CHARS) : value];
      }),
  );
}
