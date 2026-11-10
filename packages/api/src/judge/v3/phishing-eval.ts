/**
 * Adversarial phishing eval for policy v3 (docs/design/attention-engine-v3.md
 * §3(5): "Before the flip, measure its recall on an adversarial set").
 *
 * Pure: scores extracted facts against eval/phishing-eval-set.json and replays
 * each fact set through the policy under sender scenarios the eval mail cannot
 * carry (DMARC verdict, inbound history). The facts prompt sees neither, so one
 * extraction per item serves every scenario.
 */

import type { LiveTier } from "@klorn/contract";
import type { FactsV1 } from "./facts-schema.js";
import {
  laneFromFactsV3,
  POLICY_VERSION,
  type PolicyVersion,
  RISK_TRUST_MIN_HISTORY_MS,
  RISK_TRUST_MIN_INBOUND,
} from "./policy.js";
import type { PolicyReason } from "./reasons.js";
import { NEW_SENDER, type RelationshipSnapshot, UNKNOWN_RELATIONSHIP } from "./relationship.js";

const DAY_MS = 86_400_000;

export interface PhishingScenario {
  name: string;
  /** DMARC verdict for the From domain the policy sees. */
  senderAuthenticated: boolean | null;
  relationship: (decidedAt: Date) => RelationshipSnapshot | null;
}

/**
 * cold_start: the eval's own view (no verdict, no history): a new sender.
 * own_domain_dmarc_pass: an attacker on a domain they control passes DMARC.
 * known_correspondent_dmarc_pass: the residual cases the doc lists for v3.1's
 *   risk trust: a compromised correspondent, or an attacker who first got
 *   RISK_TRUST_MIN_INBOUND mails into the inbox over the history window.
 * Each item carries the automated-sender signal production computes for its
 * From, as live does. An attacker picks a From that avoids no-reply@ and
 * notifications@, so every phishing item has it off; some genuine ones have it on.
 */
export const PHISHING_SCENARIOS: readonly PhishingScenario[] = [
  { name: "cold_start", senderAuthenticated: null, relationship: () => NEW_SENDER },
  { name: "own_domain_dmarc_pass", senderAuthenticated: true, relationship: () => NEW_SENDER },
  {
    name: "known_correspondent_dmarc_pass",
    senderAuthenticated: true,
    relationship: (decidedAt) => ({
      ...UNKNOWN_RELATIONSHIP,
      vip: false,
      inboundCount: RISK_TRUST_MIN_INBOUND,
      firstSeenAt: new Date(decidedAt.getTime() - RISK_TRUST_MIN_HISTORY_MS - DAY_MS).toISOString(),
    }),
  },
];

export interface ScenarioLane {
  lane: LiveTier;
  /** The deciding reason, e.g. "ask_due_soon(askKind=pay,due=…)". */
  deciding: string;
}

/** A reason as one compact line: code plus its non-null params. */
export function describeReason(r: PolicyReason | undefined): string {
  if (!r) return "none";
  const params = Object.entries(r.params)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}=${String(v)}`);
  return params.length ? `${r.code}(${params.join(",")})` : r.code;
}

/** The pre-budget lane the policy gives these facts under one scenario. */
export function laneUnder(
  facts: FactsV1,
  scenario: PhishingScenario,
  decidedAt: Date,
  version: PolicyVersion = POLICY_VERSION,
  automatedSender = false,
): ScenarioLane {
  const d = laneFromFactsV3({
    facts,
    relationship: scenario.relationship(decidedAt),
    senderAuthenticated: scenario.senderAuthenticated,
    automatedSender,
    spam: false,
    decidedAt,
    version,
  });
  return { lane: d.lane, deciding: describeReason(d.reasons[0]) };
}

export interface PhishingItemResult {
  id: string;
  run: number;
  phishing: boolean;
  expectedLane: LiveTier;
  facts: FactsV1 | null;
  receivedAt: Date;
  asksChecked: number;
  asksDropped: number;
  /** The deterministic automated-sender signal production would pass for this From. */
  automatedSenderSignal: boolean;
}

export interface Interrupt {
  id: string;
  run: number;
  lane: LiveTier;
  deciding: string;
  automatedSenderSignal: boolean;
}

/**
 * `laneAccuracy` and `benignLaneMisses` compare against the set's labels,
 * which are cold-start lanes. Outside cold_start a genuine alert can rightly
 * PUSH through trusted risk and still show here as a miss.
 */
export interface ScenarioSummary {
  laneAccuracy: { correct: number; total: number; accuracy: number | null };
  /** Phishing mail the policy would interrupt with (PUSH) or notify as MEETING. */
  phishingInterrupts: Interrupt[];
  /** Phishing mail filed out of sight-ish (INFO/SILENT): not harmful, counted apart. */
  phishingFiled: number;
  benignLaneMisses: {
    id: string;
    run: number;
    expected: LiveTier;
    lane: LiveTier;
    deciding: string;
  }[];
}

const INTERRUPT_LANES: ReadonlySet<LiveTier> = new Set(["PUSH", "MEETING"]);
const FILED_LANES: ReadonlySet<LiveTier> = new Set(["INFO", "SILENT"]);
const ratio = (n: number, d: number) => (d ? n / d : null);
const flagged = (f: FactsV1) => f.risk.includes("phishing_suspect");

function scenarioSummary(
  scored: readonly (PhishingItemResult & { facts: FactsV1 })[],
  scenario: PhishingScenario,
  version: PolicyVersion,
): ScenarioSummary {
  let correct = 0;
  let phishingFiled = 0;
  const phishingInterrupts: Interrupt[] = [];
  const benignLaneMisses: ScenarioSummary["benignLaneMisses"] = [];
  for (const r of scored) {
    const { lane, deciding } = laneUnder(
      r.facts,
      scenario,
      r.receivedAt,
      version,
      r.automatedSenderSignal,
    );
    if (lane === r.expectedLane) correct++;
    if (r.phishing && INTERRUPT_LANES.has(lane)) {
      phishingInterrupts.push({
        id: r.id,
        run: r.run,
        lane,
        deciding,
        automatedSenderSignal: r.automatedSenderSignal,
      });
    }
    if (r.phishing && FILED_LANES.has(lane)) phishingFiled++;
    if (!r.phishing && lane !== r.expectedLane) {
      benignLaneMisses.push({ id: r.id, run: r.run, expected: r.expectedLane, lane, deciding });
    }
  }
  return {
    laneAccuracy: { correct, total: scored.length, accuracy: ratio(correct, scored.length) },
    phishingInterrupts,
    phishingFiled,
    benignLaneMisses,
  };
}

/**
 * How many answers a model other than the one asked served. The provider chain
 * fails over silently, so a run can be scored under the wrong model's name.
 * Matching is the bench's (`countServedByOther`): the served id contains the
 * asked one, provider prefix stripped. No answer (null) is not counted.
 */
export function servedByOther(served: readonly (string | null)[], asked: string): number {
  const want = asked.replace(/^[^/]+\//, "");
  return served.filter((m) => m !== null && !m.includes(want)).length;
}

/**
 * phishing_suspect recall on phishing items, false-positive rate on benign
 * ones, and per-scenario lanes. Items without facts are counted in noFacts and
 * left out of every rate except `recallWorstCase`, which counts a no-facts
 * phishing mail as missed: live, it falls back to the v2 lane, which has no
 * phishing check.
 */
export function summarizePhishingEval(
  results: readonly PhishingItemResult[],
  scenarios: readonly PhishingScenario[] = PHISHING_SCENARIOS,
  version: PolicyVersion = POLICY_VERSION,
) {
  const scored = results.filter((r): r is PhishingItemResult & { facts: FactsV1 } => !!r.facts);
  const phish = scored.filter((r) => r.phishing);
  const benign = scored.filter((r) => !r.phishing);
  const noFactsPhishing = results.filter((r) => !r.facts && r.phishing).length;
  const noFactsBenign = results.filter((r) => !r.facts && !r.phishing).length;
  const tag = (r: PhishingItemResult) => `${r.id}#${r.run}`;
  const checked = results.reduce((s, r) => s + r.asksChecked, 0);
  const dropped = results.reduce((s, r) => s + r.asksDropped, 0);
  const caught = phish.filter((r) => flagged(r.facts)).length;
  const falseFlags = benign.filter((r) => flagged(r.facts));
  return {
    items: results.length,
    noFacts: {
      total: noFactsPhishing + noFactsBenign,
      phishing: noFactsPhishing,
      benign: noFactsBenign,
    },
    policyVersion: version,
    phishing: {
      total: phish.length,
      flagged: caught,
      recall: ratio(caught, phish.length),
      recallWorstCase: ratio(caught, phish.length + noFactsPhishing),
      missed: phish.filter((r) => !flagged(r.facts)).map(tag),
    },
    benign: {
      total: benign.length,
      flagged: falseFlags.length,
      falsePositiveRate: ratio(falseFlags.length, benign.length),
      flaggedIds: falseFlags.map(tag),
    },
    evidenceValidity: ratio(checked - dropped, checked),
    scenarios: Object.fromEntries(
      scenarios.map((s) => [s.name, scenarioSummary(scored, s, version)]),
    ) as Record<string, ScenarioSummary>,
  };
}
