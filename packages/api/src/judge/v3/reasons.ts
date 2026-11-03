/**
 * Structured reasons for policy v3 decisions (docs/design/attention-engine-v3.md,
 * "Reasons and API contract"). A reason names the fact that decided the lane
 * and carries the verbatim evidence; clients localise from `code` + `params`.
 * No prose and no model names go into a reason.
 *
 * `reasons[0]` is always the deciding reason. The rest are supporting.
 */

export const REASON_CODES = [
  "pinned",
  "manual_override",
  "sender_pattern",
  "learned_rule",
  "event",
  "risk",
  "ask_due_soon",
  "addressed_to_me",
  "ask",
  "thread_turn_mine",
  "transaction_action",
  "kind",
  "transaction_record",
  "bulk",
  "default_queue",
  "ambiguous",
  "spam_floor",
  "held_budget",
  "relationship",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export type ReasonParamValue = string | number | boolean | null;

export interface PolicyReason {
  code: ReasonCode;
  /** Path into the facts that produced this reason, e.g. "asks[0]", "risk". */
  fact: string | null;
  /** Verbatim quote from the mail, copied from the facts. */
  evidence: string | null;
  params: Readonly<Record<string, ReasonParamValue>>;
}

/** Where a reason's evidence sits, so the Reader highlights the right place. */
export type EvidenceLocation = "subject" | "body";

export interface ApiReason extends PolicyReason {
  evidenceIn: EvidenceLocation | null;
}

export function reason(
  code: ReasonCode,
  fields: {
    fact?: string | null;
    evidence?: string | null;
    params?: Record<string, ReasonParamValue>;
  } = {},
): PolicyReason {
  return {
    code,
    fact: fields.fact ?? null,
    evidence: fields.evidence ?? null,
    params: { ...(fields.params ?? {}) },
  };
}

const collapseWhitespace = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Locate a reason's evidence for the Reader. Whitespace-insensitive, like the
 * extractor's substring check. Evidence not found in the subject is assumed to
 * come from the body (the extractor only accepts subject or body quotes).
 */
export function withEvidenceLocation(r: PolicyReason, subject: string | null): ApiReason {
  if (!r.evidence) return { ...r, evidenceIn: null };
  const inSubject = collapseWhitespace(subject ?? "").includes(collapseWhitespace(r.evidence));
  return { ...r, evidenceIn: inSubject ? "subject" : "body" };
}
