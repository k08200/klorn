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

import { EMPTY_JUDGE_CONTEXT, type JudgeContext } from "./judge/poc-judge.js";
import { TIERS, type Tier } from "./judge/tiers.js";
import type { LearnedRule, RulePattern } from "./learning/learned-rules.js";
import type { CorrectionExample, SenderFacts, SenderPrior } from "./learning/sender-policy.js";
import type { SenderTraitFact } from "./learning/sender-trait-store.js";

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
    readBehavior: parseNumericRecord<NonNullable<SenderFacts["readBehavior"]>>(
      raw.readBehavior,
      itemId,
      "senderFacts.readBehavior",
      [
        { key: "read", min: 0 },
        { key: "total", min: 0 },
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

/**
 * Snapshot a live JudgeContext (built by the production buildJudgeContext
 * against the founder's DB) into a committable fixture. Deliberately keeps
 * ONLY the numeric knowledge — senderPrior (tier/count/kind) and senderFacts
 * (all-count record) — because the other channels carry raw text from real
 * mail (correction few-shots quote subjects, traits quote evidence, learned
 * rules quote values) and this fixture lands in a PUBLIC repo. Null when the
 * sender has no prior and no facts: absent fixture = empty context, so we
 * never commit noise.
 */
export function judgeContextToFixture(
  context: JudgeContext,
): { senderPrior?: SenderPrior; senderFacts?: SenderFacts } | null {
  const senderPrior = context.senderPrior ?? null;
  const senderFacts = context.senderFacts ?? null;
  if (!senderPrior && !senderFacts) return null;
  return {
    ...(senderPrior ? { senderPrior } : {}),
    ...(senderFacts ? { senderFacts } : {}),
  };
}

/** RFC 2606 reserved names the eval scrubber emits as sender placeholders. */
const RESERVED_SENDER_RE =
  /@(?:[a-z0-9-]+\.)*(?:[a-z0-9-]+\.(?:example|invalid|test)|example\.(?:com|org|net))$/i;

/**
 * Return the (deduplicated) sender addresses that are scrub placeholders —
 * addresses on RFC 2606 reserved domains, which real mail can never use.
 *
 * Why this matters: `--context=db` resolves each item's sender against the
 * real DB. On a scrubbed set no sender resolves, so every sender-scoped
 * channel (prior, facts, traits) comes back empty while the user-scoped
 * correction few-shot pool is still injected into EVERY item's prompt — a
 * context that exists for no real email. The number that comes out is not a
 * cold-start score and not a warm score; it is structurally invalid. Callers
 * use a non-empty result to refuse the run instead of reporting garbage.
 */
/**
 * Instrument-integrity verdict over a run's judge sources. A transient
 * provider failure (quota trip, lockout, connection error) silently degrades
 * judgements to the keyword fallback — and the run still prints an accuracy
 * number that measures the FALLBACK, not the judge under test (observed four
 * times in one week: three CI false-fails and a local "75.5%" artifact).
 * Any keyword-fallback verdict poisons the run: callers must refuse to
 * present the numbers as a measurement.
 */
export function assessInstrumentIntegrity(sources: readonly string[]): {
  fallbackCount: number;
  total: number;
  degraded: boolean;
} {
  const fallbackCount = sources.filter((s) => s === "keyword-fallback").length;
  return { fallbackCount, total: sources.length, degraded: fallbackCount > 0 };
}

export function findScrubbedSenders(froms: Iterable<string>): string[] {
  const scrubbed = new Set<string>();
  for (const from of froms) {
    const angled = /<([^<>\s]+@[^<>\s]+)>/.exec(from);
    const bare = /^([^<>\s]+@[^<>\s]+)$/.exec(from.trim());
    const address = (angled?.[1] ?? bare?.[1])?.toLowerCase();
    if (address && RESERVED_SENDER_RE.test(address)) scrubbed.add(address);
  }
  return [...scrubbed];
}
