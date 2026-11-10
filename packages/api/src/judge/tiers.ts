/**
 * The canonical attention tier vocabulary. SINGLE SOURCE OF TRUTH.
 *
 * Ontology v2 (founder decision 2026-08-15, docs/design/tier-ontology-v2.md):
 * SILENT / INFO / QUEUE / MEETING / PUSH describe WHAT the mail is; whether
 * Klorn may auto-answer it is the per-item `autoEligible` flag plus the
 * account mode — delegation is no longer a tier. AUTO remains in the storage
 * vocabulary for legacy rows and the still-active v1 classifier
 * (TIER_V2_ENABLED off): v1 emits it, v2 never does. At flip time AUTO rows
 * are backfilled to QUEUE + autoEligible.
 *
 * There is no CALL tier. An earlier iteration added CALL as a "phone-call
 * interrupt" above PUSH, but it was never shipped end-to-end (delivery always
 * rendered it as PUSH) and it forked the domain model — calibration and the
 * POC judge counted 4 tiers while the mirror and API exposed 5. Every tier
 * type now derives from here so that can't drift again.
 *
 * Legacy AttentionItem rows may still carry tier="CALL" in the DB. Read paths
 * MUST run those through normalizeTier so they render as PUSH, not get demoted
 * to QUEUE by an unknown-value fallback.
 */

import type { LiveTier } from "@klorn/contract";

export const TIERS = ["SILENT", "INFO", "QUEUE", "MEETING", "PUSH", "AUTO"] as const;

export type Tier = (typeof TIERS)[number];

const TIER_SET: ReadonlySet<string> = new Set(TIERS);

/**
 * Coerce any stored/legacy tier string into a valid Tier.
 *  - "CALL" (retired tier) → "PUSH" (its actual delivery behaviour)
 *  - null / unknown        → "QUEUE" (visible default; lazy-backfill rows)
 */
export function normalizeTier(value: string | null | undefined, _strict = false): Tier {
  if (value === "CALL") return "PUSH";
  if (value && TIER_SET.has(value)) return value as Tier;
  return "QUEUE";
}

/**
 * normalizeTier for user-facing surfaces: additionally folds the retired v1
 * AUTO lane into QUEUE, the vocabulary's visible default (the same fold the
 * TIER_V2 backfill applies). Use this wherever a lane is shown to a person —
 * the firewall board, mail-row chips — so AUTO never renders as a lane.
 */
export function toLiveTier(value: string | null | undefined): LiveTier {
  const tier = normalizeTier(value);
  return tier === "AUTO" ? "QUEUE" : tier;
}

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && TIER_SET.has(value);
}

/**
 * Prefix stamped into AttentionItem.tierReason when the user manually moves
 * an item to a different tier. Human-readable only — NOT a trust boundary.
 * tierReason also carries judge/LLM-authored text (attention-mirror.ts), so a
 * prompt-injected email can make an LLM emit this exact prefix. Ground-truth
 * decisions (POC accuracy gate, judge-context.ts correction mining) must key
 * off AttentionItem.isManualOverride instead, which only overrideAttentionTier()
 * (attention-override.ts) can set (GHSA-cxc5-fmqv-pxv6).
 */
export const MANUAL_OVERRIDE_PREFIX = "Manual override";

export function manualOverrideReason(tier: Tier): string {
  return `${MANUAL_OVERRIDE_PREFIX} — user moved to ${tier}`;
}
