/**
 * The canonical attention tier vocabulary. SINGLE SOURCE OF TRUTH.
 *
 * Klorn is a 4-tier firewall (POC.md, LOCKED): SILENT / QUEUE / PUSH / AUTO.
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

export const TIERS = ["SILENT", "QUEUE", "PUSH", "AUTO"] as const;

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

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && TIER_SET.has(value);
}

/**
 * Prefix stamped into AttentionItem.tierReason when the user manually moves
 * an item to a different tier. This string IS the ground-truth marker: the
 * POC accuracy gate counts rows with this prefix as founder labels, and the
 * correction loop (judge-context.ts) mines them as few-shot examples. Always
 * build override reasons through manualOverrideReason() so the marker can't
 * drift.
 */
export const MANUAL_OVERRIDE_PREFIX = "Manual override";

export function manualOverrideReason(tier: Tier): string {
  return `${MANUAL_OVERRIDE_PREFIX} — user moved to ${tier}`;
}

export function isManualOverrideReason(reason: string | null | undefined): boolean {
  return typeof reason === "string" && reason.startsWith(MANUAL_OVERRIDE_PREFIX);
}
