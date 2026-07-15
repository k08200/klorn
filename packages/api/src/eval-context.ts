/**
 * Fixture → JudgeContext conversion for the offline eval (#650).
 *
 * Eval items may carry a per-item `context` fixture so the judge's
 * context-consumption path (few-shot corrections, sender-prior short-circuit,
 * sender facts, traits, learned rules) is exercised deterministically —
 * no DB, no network. Conversion is STRICT: the instrument must never fake a
 * measurement, so a typo'd fixture throws (with the item id) instead of
 * silently degrading to the empty context and reporting "no difference".
 */

import type { LearnedRule, RulePattern } from "./learned-rules.js";
import { EMPTY_JUDGE_CONTEXT, type JudgeContext } from "./poc-judge.js";
import type { CorrectionExample, SenderFacts, SenderPrior } from "./sender-policy.js";
import type { SenderTraitFact } from "./sender-trait-store.js";
import { TIERS, type Tier } from "./tiers.js";

const FIXTURE_KEYS = new Set([
  "corrections",
  "senderPrior",
  "senderFacts",
  "senderTraits",
  "learnedRules",
]);

const PRIOR_KINDS = new Set(["override", "history"]);
const RULE_PATTERNS = new Set<RulePattern>(["sender-domain", "subject-keyword"]);

class FixtureError extends Error {
  constructor(itemId: string, detail: string) {
    super(`eval context fixture for "${itemId}": ${detail}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTier(value: unknown, itemId: string, where: string): Tier {
  if (typeof value !== "string" || !TIERS.includes(value as Tier)) {
    throw new FixtureError(itemId, `${where} has an invalid tier: ${JSON.stringify(value)}`);
  }
  return value as Tier;
}

function asCount(value: unknown, itemId: string, where: string, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    throw new FixtureError(itemId, `${where} must be a number ≥ ${min}`);
  }
  return value;
}

function asString(value: unknown, itemId: string, where: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new FixtureError(itemId, `${where} must be a non-empty string`);
  }
  return value;
}

function parseCorrections(raw: unknown, itemId: string): CorrectionExample[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new FixtureError(itemId, "corrections must be an array");
  return raw.map((entry, i) => {
    if (!isPlainObject(entry))
      throw new FixtureError(itemId, `corrections[${i}] must be an object`);
    return {
      from: asString(entry.from, itemId, `corrections[${i}].from`),
      subject: asString(entry.subject, itemId, `corrections[${i}].subject`),
      tier: asTier(entry.tier, itemId, `corrections[${i}]`),
    };
  });
}

function parseSenderPrior(raw: unknown, itemId: string): SenderPrior | null {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) throw new FixtureError(itemId, "senderPrior must be an object");
  if (typeof raw.kind !== "string" || !PRIOR_KINDS.has(raw.kind)) {
    throw new FixtureError(itemId, `senderPrior.kind must be "override" or "history"`);
  }
  return {
    tier: asTier(raw.tier, itemId, "senderPrior"),
    count: asCount(raw.count, itemId, "senderPrior.count", 1),
    kind: raw.kind as SenderPrior["kind"],
  };
}

function parseTierHistory(raw: unknown, itemId: string): SenderFacts["tierHistory"] {
  if (!isPlainObject(raw))
    throw new FixtureError(itemId, "senderFacts.tierHistory must be an object");
  const history: Partial<Record<Tier, number>> = {};
  for (const [key, count] of Object.entries(raw)) {
    const tier = asTier(key, itemId, "senderFacts.tierHistory key");
    history[tier] = asCount(count, itemId, `senderFacts.tierHistory.${key}`, 0);
  }
  return history;
}

/** Nullable numeric sub-record of SenderFacts (interaction/commitments/engagement). */
function parseNumericRecord<T>(
  raw: unknown,
  itemId: string,
  where: string,
  fields: Array<{ key: string; min: number; nullable?: boolean }>,
): T | null {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) throw new FixtureError(itemId, `${where} must be an object or null`);
  const out: Record<string, number | null> = {};
  for (const { key, min, nullable } of fields) {
    if (nullable && (raw[key] === null || raw[key] === undefined)) {
      out[key] = null;
      continue;
    }
    out[key] = asCount(raw[key], itemId, `${where}.${key}`, min);
  }
  return out as T;
}

function parseSenderFacts(raw: unknown, itemId: string): SenderFacts | null {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) throw new FixtureError(itemId, "senderFacts must be an object");
  return {
    tierHistory: parseTierHistory(raw.tierHistory, itemId),
    manualOverrides:
      raw.manualOverrides === undefined
        ? 0
        : asCount(raw.manualOverrides, itemId, "senderFacts.manualOverrides", 0),
    interaction: parseNumericRecord<NonNullable<SenderFacts["interaction"]>>(
      raw.interaction,
      itemId,
      "senderFacts.interaction",
      [
        { key: "emailCount", min: 0 },
        { key: "lastEmailDaysAgo", min: 0, nullable: true },
        { key: "upcomingMeetings", min: 0 },
      ],
    ),
    commitments: parseNumericRecord<NonNullable<SenderFacts["commitments"]>>(
      raw.commitments,
      itemId,
      "senderFacts.commitments",
      [
        { key: "onTime", min: 0 },
        { key: "total", min: 0 },
      ],
    ),
    engagement: parseNumericRecord<NonNullable<SenderFacts["engagement"]>>(
      raw.engagement,
      itemId,
      "senderFacts.engagement",
      [
        { key: "importance", min: 0 },
        { key: "outboundCount", min: 0 },
      ],
    ),
  };
}

function parseSenderTraits(raw: unknown, itemId: string): SenderTraitFact[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new FixtureError(itemId, "senderTraits must be an array");
  return raw.map((entry, i) => {
    if (!isPlainObject(entry))
      throw new FixtureError(itemId, `senderTraits[${i}] must be an object`);
    const confidence = asCount(entry.confidence, itemId, `senderTraits[${i}].confidence`, 0);
    if (confidence > 1) {
      throw new FixtureError(itemId, `senderTraits[${i}].confidence must be ≤ 1`);
    }
    return {
      factKind: asString(entry.factKind, itemId, `senderTraits[${i}].factKind`),
      factValue: asString(entry.factValue, itemId, `senderTraits[${i}].factValue`),
      confidence,
      evidenceText: asString(entry.evidenceText, itemId, `senderTraits[${i}].evidenceText`),
    } as SenderTraitFact;
  });
}

function parseLearnedRules(raw: unknown, itemId: string): LearnedRule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new FixtureError(itemId, "learnedRules must be an array");
  return raw.map((entry, i) => {
    if (!isPlainObject(entry))
      throw new FixtureError(itemId, `learnedRules[${i}] must be an object`);
    if (typeof entry.pattern !== "string" || !RULE_PATTERNS.has(entry.pattern as RulePattern)) {
      throw new FixtureError(
        itemId,
        `learnedRules[${i}].pattern must be "sender-domain" or "subject-keyword"`,
      );
    }
    return {
      pattern: entry.pattern as RulePattern,
      value: asString(entry.value, itemId, `learnedRules[${i}].value`),
      tier: asTier(entry.tier, itemId, `learnedRules[${i}]`),
    };
  });
}

/**
 * Convert one eval item's `context` fixture into a JudgeContext.
 * Absent fixture → EMPTY_JUDGE_CONTEXT (byte-identical to the pre-#650 eval).
 */
export function fixtureToJudgeContext(fixture: unknown, itemId: string): JudgeContext {
  if (fixture === undefined || fixture === null) return EMPTY_JUDGE_CONTEXT;
  if (!isPlainObject(fixture)) {
    throw new FixtureError(itemId, "context must be an object");
  }
  for (const key of Object.keys(fixture)) {
    if (!FIXTURE_KEYS.has(key)) {
      throw new FixtureError(itemId, `unknown context key "${key}"`);
    }
  }
  return {
    corrections: parseCorrections(fixture.corrections, itemId),
    senderPrior: parseSenderPrior(fixture.senderPrior, itemId),
    senderFacts: parseSenderFacts(fixture.senderFacts, itemId),
    senderTraits: parseSenderTraits(fixture.senderTraits, itemId),
    learnedRules: parseLearnedRules(fixture.learnedRules, itemId),
  };
}
