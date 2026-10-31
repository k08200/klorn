/**
 * Persistence for v3 facts (AttentionFacts, docs/design/attention-engine-v3.md
 * §3 "Facts are persisted per item with factsVersion, model, provider and
 * extractedAt"). One row per (userId, source, sourceId); a rerun replaces it.
 * Additive: nothing here touches v2 rows.
 */

import { type AttentionSource, Prisma } from "@prisma/client";
import { db } from "../../db.js";
import type { FactsExtraction } from "./facts-extractor.js";
import { FACTS_VERSION } from "./facts-schema.js";
import type { RelationshipSnapshot } from "./relationship.js";

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
    evidenceCheck: asJson(x.evidenceCheck),
    issues: x.issues.slice(0, MAX_STORED_ISSUES).map((s) => s.slice(0, MAX_ISSUE_CHARS)),
    escalate: x.escalate,
    escalateReasons: [...x.escalateReasons],
    v2Tier: input.v2Tier,
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
    update,
  });
}
