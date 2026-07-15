import { asEnum } from "../llm/llm-coerce.js";

export type SenderTraitKind = "relationship" | "recurring_intent";

export interface CandidateTrait {
  factKind: SenderTraitKind;
  factValue: string;
  confidence: number;
  evidenceText: string;
}

// Vocabulary aligns with EmailCategory (investor/customer/internal/automated)
// where sensible, for cross-signal consistency.
export const RELATIONSHIP_VALUES = [
  "vendor",
  "customer",
  "investor",
  "internal_colleague",
  "recruiter",
  "service_automated",
  "personal",
  "unknown",
] as const;

export const RECURRING_INTENT_VALUES = [
  "billing",
  "scheduling",
  "newsletter",
  "transactional_receipt",
  "support",
  "sales_outreach",
  "personal_correspondence",
  "none",
] as const;

const VALUES_BY_KIND: Record<SenderTraitKind, readonly string[]> = {
  relationship: RELATIONSHIP_VALUES,
  recurring_intent: RECURRING_INTENT_VALUES,
};

/** The fact kinds extracted in v0. */
export const TRAIT_KINDS: readonly SenderTraitKind[] = ["relationship", "recurring_intent"];

/**
 * Returns the value if it is in the kind's closed set, else null. A null means
 * the model produced an out-of-taxonomy value — that fact is dropped, not stored.
 */
export function validateTraitValue(kind: SenderTraitKind, value: unknown): string | null {
  const allowed = VALUES_BY_KIND[kind];
  const coerced = asEnum(value, allowed as readonly string[], "");
  return coerced === "" ? null : coerced;
}
