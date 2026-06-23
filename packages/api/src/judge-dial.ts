/**
 * Judge dial — model-routing policy.
 *
 * The fourth piece of the deterministic core, and the one the strategy calls
 * the "dial": which model the judge's LLM step runs on. The firewall already
 * has a coarse dial — the deterministic short-circuits (fast-path, sender-prior)
 * skip the model entirely when the ontology is sure. This adds the next rung:
 * run the cheap/local model first, and escalate to a stronger model ONLY when
 * the cheap model is in its own blind spot — i.e. it reported low confidence.
 *
 * This is the Klorn analog of Ripple's bc56d80 ("LLM only on the graph's blind
 * spot"): frontier only on the cheap model's blind spot. It is also the
 * measurement instrument the strategy wants — escalations log the cheap-vs-
 * strong delta on exactly the ambiguous emails, which is the signal a future
 * narrow fine-tune is aimed at.
 *
 * OFF BY DEFAULT: with JUDGE_ESCALATION_MODEL unset, resolveEscalation always
 * returns null, so the judge behaves byte-identically to a single-model call.
 */

/**
 * Confidence below which the cheap model is treated as in its blind spot and
 * the email is worth a stronger look. 0.5 is the same boundary tier-policy
 * uses to send low-confidence mail to QUEUE — below it, the model itself says
 * its scores could go either way.
 */
export const ESCALATION_CONFIDENCE_FLOOR = 0.5;

/** The stronger model to escalate to, or null when the dial is off. */
export function escalationModel(): string | null {
  const model = process.env.JUDGE_ESCALATION_MODEL?.trim();
  return model ? model : null;
}

/**
 * Decide whether to escalate, and to which model. Returns the target model
 * name, or null to stay on the cheap result.
 *
 * Escalation is suppressed when:
 *  - the caller pinned a model (playground BYOK / eval) — their choice is
 *    deliberate and must stay deterministic,
 *  - the cheap model was already confident (>= floor),
 *  - the dial is off (no escalation model configured), or
 *  - the escalation target is the same model already used.
 */
export function resolveEscalation(args: {
  confidence: number;
  callerPinnedModel: boolean;
  baseModel: string;
}): string | null {
  if (args.callerPinnedModel) return null;
  if (args.confidence >= ESCALATION_CONFIDENCE_FLOOR) return null;
  const target = escalationModel();
  if (!target || target === args.baseModel) return null;
  return target;
}
