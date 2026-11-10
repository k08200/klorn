/**
 * Persistence for v3 facts (AttentionFacts, docs/design/attention-engine-v3.md
 * §3 "Facts are persisted per item with factsVersion, model, provider and
 * extractedAt"). One row per (userId, source, sourceId); a rerun replaces it.
 * Additive: nothing here touches v2 rows.
 */

import { type AttentionSource, Prisma } from "@prisma/client";
import { db } from "../../db.js";
import type { FactsExtraction } from "./facts-extractor.js";
import type { CertainPreFacts } from "./facts-merge.js";
import {
  FACT_FIELDS,
  FACTS_VERSION,
  type FactField,
  type FactsV1,
  parseFactsV1,
} from "./facts-schema.js";
import type { PreFactSignals } from "./pre-facts.js";
import { parseRelationshipSnapshot, type RelationshipSnapshot } from "./relationship.js";

export const MAX_STORED_ISSUES = 20;
export const MAX_ISSUE_CHARS = 200;

export interface StoreFactsInput {
  userId: string;
  source: AttentionSource;
  sourceId: string;
  extraction: FactsExtraction;
  relationship: RelationshipSnapshot | null;
  /** The v2 lane shown when the shadow ran. */
  v2Tier: string | null;
  extractedAt: Date;
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export function toAttentionFactsData(input: StoreFactsInput) {
  const x = input.extraction;
  return {
    userId: input.userId,
    source: input.source,
    sourceId: input.sourceId,
    factsVersion: FACTS_VERSION,
    factsSource: x.source,
    model: x.model,
    provider: x.provider,
    extractedAt: input.extractedAt,
    // "none" rows keep only the certain pre-facts (policy re-derives the rest).
    facts: asJson(x.facts ?? x.preFacts),
    certainFields: [...x.certain],
    signals: asJson(x.signals),
    relationship: input.relationship ? asJson(input.relationship) : Prisma.DbNull,
    // Paths only: a dropped quote is model text that is not in the mail.
    evidenceCheck: asJson({
      checked: x.evidenceCheck.checked,
      dropped: x.evidenceCheck.dropped.map((d) => ({ path: d.path })),
    }),
    issues: x.issues.slice(0, MAX_STORED_ISSUES).map((s) => s.slice(0, MAX_ISSUE_CHARS)),
    escalate: x.escalate,
    escalateReasons: [...x.escalateReasons],
    v2Tier: input.v2Tier,
    promptTokens: x.usage?.promptTokens ?? null,
    completionTokens: x.usage?.completionTokens ?? null,
    costUsd: x.usage?.costUsd ?? null,
  } satisfies Prisma.AttentionFactsUncheckedCreateInput;
}

export async function saveAttentionFacts(
  input: StoreFactsInput,
  client: Pick<typeof db, "attentionFacts"> = db,
): Promise<void> {
  const data = toAttentionFactsData(input);
  const { userId, source, sourceId, ...update } = data;
  await client.attentionFacts.upsert({
    where: { userId_source_sourceId: { userId, source, sourceId } },
    create: data,
    // A row without LLM facts never replaces one: if the shadow and the live
    // path both wrote the same mail, the facts the policy used must survive.
    update: data.factsSource === "none" ? {} : update,
  });
}

/** The stored columns the live decision and replay read back. */
export interface StoredFactsRow {
  factsVersion: number;
  factsSource: string;
  facts: unknown;
  certainFields: string[];
  signals: unknown;
  relationship: unknown;
}

export interface StoredFacts {
  factsSource: "llm" | "none";
  /** Valid FactsV1 from an "llm" row at this facts version; null otherwise. */
  facts: FactsV1 | null;
  /** The certain pre-facts, each re-validated, for the keyword merge. */
  pre: CertainPreFacts | null;
  signals: PreFactSignals | null;
  relationship: RelationshipSnapshot | null;
}

/** Placeholder values a certain field is validated against, one field at a time. */
const NEUTRAL_FACTS: FactsV1 = {
  asks: [],
  addressedTo: "group",
  threadTurn: "none",
  event: null,
  transaction: null,
  risk: [],
  kind: "personal",
  ambiguous: false,
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Read a stored row back. Stored JSON is not trusted blindly: LLM facts must
 * be at this facts version and pass the v1 validator, and each certain field
 * must be a known field whose value validates on its own.
 */
export function parseStoredFacts(row: StoredFactsRow): StoredFacts {
  const sameVersion = row.factsVersion === FACTS_VERSION;
  const factsSource = row.factsSource === "llm" ? "llm" : "none";
  const facts = sameVersion && factsSource === "llm" ? parseFactsV1(row.facts).facts : null;
  const signals = isRecord(row.signals) ? (row.signals as unknown as PreFactSignals) : null;
  return {
    factsSource,
    facts,
    pre: sameVersion ? certainPreFacts(row.facts, row.certainFields) : null,
    signals,
    relationship: parseRelationshipSnapshot(row.relationship),
  };
}

function certainPreFacts(raw: unknown, fields: readonly string[]): CertainPreFacts | null {
  if (!isRecord(raw)) return null;
  const facts: Partial<FactsV1> = {};
  const certain: FactField[] = [];
  for (const field of fields) {
    if (!(FACT_FIELDS as readonly string[]).includes(field) || !(field in raw)) continue;
    const name = field as FactField;
    const parsed = parseFactsV1({ ...NEUTRAL_FACTS, [name]: raw[name] }).facts;
    if (!parsed) continue;
    Object.assign(facts, { [name]: parsed[name] });
    certain.push(name);
  }
  return { facts, certain };
}

/** The stored facts for one item, or null when none were stored. */
export async function findAttentionFacts(
  userId: string,
  source: AttentionSource,
  sourceId: string,
  client: Pick<typeof db, "attentionFacts"> = db,
): Promise<StoredFacts | null> {
  const row = await client.attentionFacts.findUnique({
    where: { userId_source_sourceId: { userId, source, sourceId } },
    select: {
      factsVersion: true,
      factsSource: true,
      facts: true,
      certainFields: true,
      signals: true,
      relationship: true,
    },
  });
  return row ? parseStoredFacts(row) : null;
}
