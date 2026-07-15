/**
 * Learned-rule layer — read side (matcher + primitives). Pure, no DB.
 *
 * Klorn's classifier already learns two ways: per-sender priors that short-
 * circuit the LLM (judge-context.ts) and global threshold nudges (ontology-
 * proposals.ts). Both are narrow: the prior is keyed to an *exact* address, and
 * the threshold knob is *global*. Neither can express the generalisation a user
 * actually performs in their head — "anything from this newsletter domain is
 * SILENT", "anything whose subject is an invoice goes to QUEUE" — for senders
 * they have never seen before.
 *
 * A `LearnedRule` is that generalisation, mined from repeated manual overrides
 * (learned-rule-mining.ts) and — like a threshold proposal — only ever applied
 * after human approval (deterministic-floor doctrine: every decision the
 * firewall makes from learned state must be reviewable and reversible). This
 * file is the deterministic matcher the classifier will consult; it scores an
 * email against a set of already-APPROVED rules and never calls a model.
 *
 * Kept pure (no DB, no Date.now) so the rule semantics can be unit-tested in
 * isolation, exactly like proposeThresholdAdjustments.
 */

import type { Tier } from "../judge/tiers.js";
import { extractEmailAddress } from "../mail/email-address.js";

/** The deterministic generalisations a learned rule can express. */
export type RulePattern = "sender-domain" | "subject-keyword";

/**
 * One approved learned rule. The DB row (Slice 2) carries id / status /
 * evidence; the matcher only needs the pattern, the value to match, and the
 * tier to assign.
 */
export interface LearnedRule {
  id?: string;
  pattern: RulePattern;
  /** Normalised domain (sender-domain) or single token (subject-keyword). */
  value: string;
  tier: Tier;
}

/** Email shape the matcher needs — just the bytes the rules key off. */
export interface EmailForMatch {
  from: string;
  subject: string;
}

/** Minimum token length kept by {@link subjectTokens} — drops short noise. */
export const MIN_TOKEN_LEN = 4;

/**
 * Common subject noise that survives the length filter but carries no signal.
 * Conservative on purpose: a smaller stopword set under-prunes (a few junk
 * tokens) rather than over-prunes (dropping a real signal word).
 */
const SUBJECT_STOPWORDS: ReadonlySet<string> = new Set([
  "your",
  "with",
  "this",
  "that",
  "from",
  "have",
  "will",
  "please",
  "reply",
  "regarding",
]);

/** sender-domain beats subject-keyword: a domain match is the stronger signal. */
const PATTERN_PRECEDENCE: Record<RulePattern, number> = {
  "sender-domain": 0,
  "subject-keyword": 1,
};

/**
 * Domain of a `From` header, lowercased, or null when unparseable. The address
 * is parsed with the shared {@link extractEmailAddress}; the domain is the part
 * after the final `@`.
 */
export function domainOfAddress(from: string): string | null {
  const address = extractEmailAddress(from);
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  const domain = address.slice(at + 1).trim();
  return domain.length > 0 && domain.includes(".") ? domain : null;
}

/**
 * Normalise a subject into deduped keyword tokens: lowercase, split on non-
 * alphanumerics, then drop tokens that are short, purely numeric, or stopwords.
 * Same tokeniser used by mining and matching so a rule mined from a subject
 * matches that same subject.
 */
export function subjectTokens(subject: string): string[] {
  const seen = new Set<string>();
  for (const raw of subject.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (raw.length < MIN_TOKEN_LEN) continue;
    if (/^\d+$/.test(raw)) continue;
    if (SUBJECT_STOPWORDS.has(raw)) continue;
    seen.add(raw);
  }
  return [...seen];
}

/**
 * Return the single best already-APPROVED rule that matches the email, or null.
 * sender-domain matches win over subject-keyword; within the same pattern the
 * first rule in input order wins (caller may pre-sort by evidence). Pure.
 */
export function matchLearnedRules(email: EmailForMatch, rules: LearnedRule[]): LearnedRule | null {
  if (rules.length === 0) return null;

  const domain = domainOfAddress(email.from);
  const tokens = new Set(subjectTokens(email.subject));

  let best: LearnedRule | null = null;
  let bestRank = Number.POSITIVE_INFINITY;

  rules.forEach((rule, index) => {
    const matches =
      rule.pattern === "sender-domain"
        ? domain !== null && rule.value === domain
        : tokens.has(rule.value);
    if (!matches) return;
    // Rank by pattern precedence, then input order — fully deterministic.
    const rank = PATTERN_PRECEDENCE[rule.pattern] * 1_000_000 + index;
    if (rank < bestRank) {
      bestRank = rank;
      best = rule;
    }
  });

  return best;
}
