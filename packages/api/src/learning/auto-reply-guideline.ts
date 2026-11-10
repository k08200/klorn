/**
 * Ontology v2 auto-mode reply guideline (docs/design/tier-ontology-v2.md).
 *
 * The guideline is the user's standing instruction for replies Klorn sends
 * UNATTENDED (attentionMode=AUTO + autoEligible items). It is user-authored
 * settings text — deliberately injected into the reply prompt as instructions,
 * unlike mail content, which stays wrapped as untrusted data.
 *
 * The default is the founder-approved four principles (2026-08-15): polite &
 * concise / never commit / mirror the mail's language / no personal data.
 * Kept in English because it feeds the LLM prompt; the settings UI localizes
 * the DISPLAY of the default, while a user's own override is stored verbatim.
 */

export const ATTENTION_MODES = ["BASIC", "AUTO"] as const;
export type AttentionMode = (typeof ATTENTION_MODES)[number];

export const DEFAULT_AUTO_REPLY_GUIDELINE = [
  "Always be polite and concise.",
  'Never commit to dates, amounts, or deadlines — defer with a line like "I\'ll confirm and get back to you."',
  "Reply in the same language as the received email.",
  "Do not mention personal information beyond the sender signature.",
].join("\n");

/** Longest guideline we store — it rides inside every auto-reply prompt. */
export const MAX_GUIDELINE_LENGTH = 2000;

/** Coerce any stored/user value into a valid mode. Unknown → BASIC (safe). */
export function normalizeAttentionMode(value: unknown): AttentionMode {
  return value === "AUTO" ? "AUTO" : "BASIC";
}

/**
 * Normalize a user-submitted guideline: trim, cap, empty → null (null means
 * "the default applies" — the UI shows the default as an editable draft).
 */
export function normalizeAutoReplyGuideline(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_GUIDELINE_LENGTH);
}

/** The guideline in force: the user's override, else the founder default. */
export function effectiveAutoReplyGuideline(stored: string | null | undefined): string {
  const normalized = normalizeAutoReplyGuideline(stored);
  return normalized ?? DEFAULT_AUTO_REPLY_GUIDELINE;
}
