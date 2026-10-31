/**
 * Facts v1 with no LLM in the loop: deterministic pre-facts plus the keyword
 * vocabulary of keyword-policy.ts. Principle 9 of
 * docs/design/attention-engine-v3.md: when the model is down, facts must still
 * reproduce at least today's keyword-fallback lanes (marketing → SILENT,
 * automated → INFO, scheduling → MEETING, everything else → QUEUE).
 *
 * Conservative on purpose, mirroring the v2 fallback's own guards: no
 * deadline is ever invented, and no security_alert is raised from keywords
 * (a phishing blast would otherwise become an interrupt during an outage).
 * Always `ambiguous`, so the item is re-extracted once a model is back.
 */

import {
  ACCOUNT_CONFIRMATION_RE,
  isKeywordMarketing,
  isTransactionalSender,
  URGENT_WORDS_RE,
} from "../keyword-policy.js";
import type { FactAsk, FactsV1 } from "./facts-schema.js";
import type { PreFacts, PreFactsInput } from "./pre-facts.js";

/** Chars of context kept on each side of a matched urgent word. */
const EVIDENCE_CONTEXT_CHARS = 40;

/** A verbatim excerpt around the first urgent word in `text`, or null. */
function urgentExcerpt(text: string): string | null {
  const m = URGENT_WORDS_RE.exec(text);
  if (!m) return null;
  const start = Math.max(0, m.index - EVIDENCE_CONTEXT_CHARS);
  const end = Math.min(text.length, m.index + m[0].length + EVIDENCE_CONTEXT_CHARS);
  return text.slice(start, end).trim();
}

function urgentAsk(input: PreFactsInput): FactAsk[] {
  const sources = [input.subject ?? "", input.body?.trim() ? input.body : (input.snippet ?? "")];
  for (const text of sources) {
    const evidence = urgentExcerpt(text);
    if (evidence) return [{ kind: "reply", object: "reply", due: null, evidence }];
  }
  return [];
}

function kindOf(input: PreFactsInput, pre: PreFacts): FactsV1["kind"] {
  if (pre.facts.kind) return pre.facts.kind;
  if (isKeywordMarketing(input)) return "newsletter";
  if (pre.signals.automatedSender || pre.signals.autoSubmitted) return "notification";
  if (pre.signals.schedulingIntent) return "meeting";
  return "personal";
}

export function keywordFallbackFacts(input: PreFactsInput, pre: PreFacts): FactsV1 {
  const addressedTo = pre.facts.addressedTo ?? (isKeywordMarketing(input) ? "bulk" : "me_direct");
  const bulk = addressedTo === "bulk";
  const machine = pre.signals.automatedSender || pre.signals.autoSubmitted;
  const asks = pre.facts.asks ?? (bulk || machine ? [] : urgentAsk(input));
  const kind = kindOf(input, pre);
  const event =
    pre.facts.event ??
    (pre.signals.schedulingIntent && !bulk
      ? { proposedTimes: [], hasInvite: false, conflict: null }
      : null);
  const head = `${input.subject ?? ""} ${input.snippet ?? ""}`;
  return {
    asks,
    addressedTo,
    threadTurn:
      pre.facts.threadTurn ??
      (bulk || machine ? "none" : asks.length > 0 ? "mine_to_reply" : "none"),
    event,
    transaction: isTransactionalSender(input.from)
      ? { kind: "shipping", actionRequired: false }
      : null,
    risk: ACCOUNT_CONFIRMATION_RE.test(head) ? ["account_change"] : [],
    kind,
    ambiguous: true,
  };
}
