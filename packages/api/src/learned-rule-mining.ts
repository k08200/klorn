/**
 * Learned-rule layer — write side (miner). Pure, no DB.
 *
 * Turns a user's accumulated manual overrides into *candidate* generalising
 * rules (learned-rules.ts). This is the "acquire" step: instead of re-deriving
 * the same judgement every time, repeated corrections that share a structure
 * are lifted into one reviewable rule that also covers senders the user has
 * never seen.
 *
 * Mirrors ontology-proposals.ts deliberately — pure, bounded, conservative,
 * evidence-stamped — so the two write sides of the shared ontology behave the
 * same. A candidate is only emitted when the signal is strong enough that it
 * is unlikely to be one sender's quirk:
 *   - at least {@link MIN_RULE_EVIDENCE} overrides agree, AND
 *   - they are unanimous on the target tier (a mixed group is not a rule), AND
 *   - they span at least {@link MIN_DOMAIN_DISTINCT_SENDERS} distinct senders
 *     (a single repeated sender is already covered by the exact sender-prior in
 *     judge-context.ts — a rule there would be redundant and overfit).
 *
 * Candidates are advisory: a human approves one before the classifier acts on
 * it (Slice 5), exactly like a threshold proposal. Kept Date.now-free — the
 * caller passes `now` — so age-gating is deterministic under test.
 */

import { extractEmailAddress } from "./email-address.js";
import { domainOfAddress, type RulePattern, subjectTokens } from "./learned-rules.js";
import type { Tier } from "./tiers.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Need at least this many agreeing overrides before a rule is even proposed. */
export const MIN_RULE_EVIDENCE = 3;
/** A rule must generalise across at least this many distinct senders. */
export const MIN_DOMAIN_DISTINCT_SENDERS = 2;
/** Overrides older than this are ignored — tastes drift (mirrors sender-prior). */
export const RULE_MAX_AGE_DAYS = 60;

/** One manual override, reduced to the bytes mining keys off. */
export interface OverrideObservation {
  from: string;
  subject: string;
  /** The tier the user moved the item TO. */
  tier: Tier;
  /** Provenance — the AttentionItem/source id this override came from. */
  sourceId: string;
  /** Epoch ms of the override (for age-gating). */
  updatedAt: number;
}

/** A proposed learned rule plus the evidence that justifies it. */
export interface LearnedRuleCandidate {
  pattern: RulePattern;
  value: string;
  tier: Tier;
  evidenceCount: number;
  distinctSenders: number;
  /** The override sourceIds this rule was mined from — review + reversibility. */
  sourceIds: string[];
}

export interface MineOpts {
  /** Current time (epoch ms) for age-gating. Required to stay Date.now-free. */
  now: number;
  minEvidence?: number;
  minDistinctSenders?: number;
  maxAgeDays?: number;
}

/** Mutable accumulator while grouping observations by a pattern value. */
interface Group {
  tier: Tier | null;
  unanimous: boolean;
  senders: Set<string>;
  sourceIds: string[];
}

function emptyGroup(): Group {
  return { tier: null, unanimous: true, senders: new Set(), sourceIds: [] };
}

/** Fold one observation into its group, tracking unanimity + distinct senders. */
function addToGroup(group: Group, tier: Tier, sender: string, sourceId: string): void {
  if (group.tier === null) group.tier = tier;
  else if (group.tier !== tier) group.unanimous = false;
  group.senders.add(sender);
  group.sourceIds.push(sourceId);
}

/** Promote groups that clear every floor into sorted candidates. */
function groupsToCandidates(
  groups: Map<string, Group>,
  pattern: RulePattern,
  minEvidence: number,
  minDistinctSenders: number,
): LearnedRuleCandidate[] {
  const out: LearnedRuleCandidate[] = [];
  for (const [value, group] of groups) {
    if (!group.unanimous || group.tier === null) continue;
    if (group.sourceIds.length < minEvidence) continue;
    if (group.senders.size < minDistinctSenders) continue;
    out.push({
      pattern,
      value,
      tier: group.tier,
      evidenceCount: group.sourceIds.length,
      distinctSenders: group.senders.size,
      sourceIds: [...group.sourceIds],
    });
  }
  return out.sort((a, b) => b.evidenceCount - a.evidenceCount || a.value.localeCompare(b.value));
}

/**
 * Mine generalising rule candidates from manual overrides. Pure. Returns an
 * empty array when no group clears the evidence / unanimity / distinct-sender
 * floors. sender-domain candidates are listed before subject-keyword ones.
 */
export function mineLearnedRules(
  observations: OverrideObservation[],
  opts: MineOpts,
): LearnedRuleCandidate[] {
  const minEvidence = opts.minEvidence ?? MIN_RULE_EVIDENCE;
  const minDistinctSenders = opts.minDistinctSenders ?? MIN_DOMAIN_DISTINCT_SENDERS;
  const maxAgeMs = (opts.maxAgeDays ?? RULE_MAX_AGE_DAYS) * DAY_MS;

  const byDomain = new Map<string, Group>();
  const byKeyword = new Map<string, Group>();

  for (const o of observations) {
    if (opts.now - o.updatedAt > maxAgeMs) continue;
    const sender = extractEmailAddress(o.from);

    const domain = domainOfAddress(o.from);
    if (domain !== null) {
      const group = byDomain.get(domain) ?? emptyGroup();
      addToGroup(group, o.tier, sender, o.sourceId);
      byDomain.set(domain, group);
    }

    for (const token of subjectTokens(o.subject)) {
      const group = byKeyword.get(token) ?? emptyGroup();
      addToGroup(group, o.tier, sender, o.sourceId);
      byKeyword.set(token, group);
    }
  }

  return [
    ...groupsToCandidates(byDomain, "sender-domain", minEvidence, minDistinctSenders),
    ...groupsToCandidates(byKeyword, "subject-keyword", minEvidence, minDistinctSenders),
  ];
}
