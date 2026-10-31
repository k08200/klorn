/**
 * Facts v1 with no LLM in the loop: deterministic pre-facts plus the keyword
 * vocabulary of keyword-policy.ts. Principle 9 of
 * docs/design/attention-engine-v3.md: when the model is down, facts must keep
 * today's keyword-fallback lanes for anything that needs the user. Under the
 * doc §3(4) policy: marketing → SILENT, an urgent word from anyone else (a
 * person or a machine) → an ask → QUEUE, scheduling → MEETING, automated
 * without urgency → INFO, a person → QUEUE.
 *
 * Deliberate differences from the v2 fallback, all on the quiet side for mail
 * with no urgent word: list mail from a machine (List-Unsubscribe) is bulk
 * (SILENT/INFO, v2 kept it in QUEUE), and no keyword ever creates a PUSH: no
 * deadline is invented and no security_alert is raised from keywords (a
 * phishing blast would otherwise interrupt during an outage). Always
 * `ambiguous`, so the item is re-extracted once a model is back.
 */

import { ACCOUNT_CONFIRMATION_RE, isKeywordMarketing, URGENT_WORDS_RE } from "../keyword-policy.js";
import { cleanText, type FactAsk, type FactsV1, MAX_EVIDENCE_CHARS } from "./facts-schema.js";
import type { PreFacts, PreFactsInput } from "./pre-facts.js";

/** Chars of context kept on each side of a matched urgent word. */
const EVIDENCE_CONTEXT_CHARS = 40;
/** Chars of subject/body scanned for an urgent word. */
const URGENT_SCAN_CHARS = 4000;

/** A verbatim excerpt around the first urgent word in `text`, or null. */
function urgentExcerpt(text: string): string | null {
  const chars = Array.from(text.slice(0, URGENT_SCAN_CHARS));
  const joined = chars.join("");
  const m = URGENT_WORDS_RE.exec(joined);
  if (!m) return null;
  // Index in code points, so the cut never splits a surrogate pair.
  const at = Array.from(joined.slice(0, m.index)).length;
  const len = Array.from(m[0]).length;
  const start = Math.max(0, at - EVIDENCE_CONTEXT_CHARS);
  const end = Math.min(chars.length, at + len + EVIDENCE_CONTEXT_CHARS);
  return cleanText(chars.slice(start, end).join(""), MAX_EVIDENCE_CHARS) || null;
}

function urgentAsk(input: PreFactsInput, machine: boolean): FactAsk[] {
  const sources = [input.subject ?? "", input.body?.trim() ? input.body : (input.snippet ?? "")];
  for (const text of sources) {
    const evidence = urgentExcerpt(text);
    if (!evidence) continue;
    // A machine cannot be answered; its urgent notice is something to look at.
    return machine
      ? [{ kind: "review", object: "notice", due: null, evidence }]
      : [{ kind: "reply", object: "reply", due: null, evidence }];
  }
  return [];
}

function isMarketing(input: PreFactsInput, pre: PreFacts): boolean {
  return pre.facts.kind === "promotion" || pre.signals.clearMarketing || isKeywordMarketing(input);
}

function kindOf(input: PreFactsInput, pre: PreFacts, machine: boolean): FactsV1["kind"] {
  if (pre.facts.kind) return pre.facts.kind;
  if (isKeywordMarketing(input)) return "newsletter";
  if (machine) return "notification";
  if (pre.signals.schedulingIntent) return "meeting";
  return "personal";
}

export function keywordFallbackFacts(input: PreFactsInput, pre: PreFacts): FactsV1 {
  const marketing = isMarketing(input, pre);
  const addressedTo = pre.facts.addressedTo ?? (marketing ? "bulk" : "me_direct");
  const machine = pre.signals.automatedSender || pre.signals.autoSubmitted;
  const asks = pre.facts.asks
    ? pre.facts.asks.map((a) => ({ ...a }))
    : marketing
      ? []
      : urgentAsk(input, machine);
  const bulk = addressedTo === "bulk";
  const event = pre.facts.event
    ? { ...pre.facts.event, proposedTimes: [...pre.facts.event.proposedTimes] }
    : pre.signals.schedulingIntent && !bulk
      ? { proposedTimes: [], hasInvite: false, conflict: null }
      : null;
  const defaultTurn = !bulk && !machine && asks.length > 0 ? "mine_to_reply" : "none";
  const head = `${input.subject ?? ""} ${input.snippet ?? ""}`.slice(0, URGENT_SCAN_CHARS);
  return {
    asks,
    addressedTo,
    threadTurn: pre.facts.threadTurn ?? defaultTurn,
    event,
    transaction: null,
    risk: ACCOUNT_CONFIRMATION_RE.test(head) ? ["account_change"] : [],
    kind: kindOf(input, pre, machine),
    ambiguous: true,
  };
}
