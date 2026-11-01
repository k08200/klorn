/**
 * Seeded generators for policy v3 property tests. Deterministic (mulberry32),
 * so a failing case reproduces from its iteration index.
 */

import { TIERS, type Tier } from "../../judge/tiers.js";
import {
  ADDRESSED_TO,
  ASK_KINDS,
  type FactAsk,
  type FactsV1,
  MAIL_KINDS,
  type RelationshipSnapshot,
  RISKS,
  THREAD_TURNS,
  TRANSACTION_KINDS,
} from "../../judge/v3/policy-types.js";

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)] as T;
const chance = (rng: Rng, p: number): boolean => rng() < p;
const HOUR = 3_600_000;

/** Due offsets around the decision time, covering every policy boundary. */
const DUE_OFFSETS_H = [-72, -1, 0, 1, 23, 24, 25, 48, 71, 72, 167, 168, 400] as const;

export function genDue(rng: Rng, now: Date): string | null {
  if (chance(rng, 0.3)) return null;
  if (chance(rng, 0.03)) return "not-a-date";
  return new Date(now.getTime() + pick(rng, DUE_OFFSETS_H) * HOUR).toISOString();
}

export function genAsk(rng: Rng, now: Date, i: number): FactAsk {
  return {
    kind: pick(rng, ASK_KINDS),
    object: `object ${i}`,
    due: genDue(rng, now),
    evidence: `evidence quote ${i}`,
  };
}

export function genFacts(rng: Rng, now: Date): FactsV1 {
  const askCount = chance(rng, 0.45) ? 0 : Math.floor(rng() * 3) + 1;
  return {
    asks: Array.from({ length: askCount }, (_, i) => genAsk(rng, now, i)),
    addressedTo: pick(rng, ADDRESSED_TO),
    threadTurn: pick(rng, THREAD_TURNS),
    event: chance(rng, 0.2)
      ? {
          proposedTimes: chance(rng, 0.5)
            ? [new Date(now.getTime() + 26 * HOUR).toISOString()]
            : [],
          hasInvite: chance(rng, 0.5),
          conflict: pick(rng, [true, false, null] as const),
        }
      : null,
    transaction: chance(rng, 0.25)
      ? { kind: pick(rng, TRANSACTION_KINDS), actionRequired: chance(rng, 0.4) }
      : null,
    risk: RISKS.filter(() => chance(rng, 0.12)),
    kind: pick(rng, MAIL_KINDS),
    ambiguous: chance(rng, 0.1),
  };
}

const maybe = <T>(rng: Rng, value: T): T | null => (chance(rng, 0.3) ? null : value);

export function genRelationship(rng: Rng, now: Date): RelationshipSnapshot | null {
  if (chance(rng, 0.2)) return null;
  return {
    sentCount: maybe(rng, Math.floor(rng() * 60)),
    lastSentAt: maybe(
      rng,
      new Date(now.getTime() - Math.floor(rng() * 400) * 24 * HOUR).toISOString(),
    ),
    medianReplyLatencyMs: maybe(rng, Math.floor(rng() * 7 * 24) * HOUR),
    sameOrgDomain: maybe(rng, chance(rng, 0.5)),
    coAttendanceNext14d: maybe(rng, Math.floor(rng() * 4)),
    pinned: maybe(rng, chance(rng, 0.05)),
    vip: maybe(rng, chance(rng, 0.05)),
    dismissCount: maybe(rng, Math.floor(rng() * 10)),
    inboundCount: maybe(rng, Math.floor(rng() * 80)),
    inboundThreadCount: maybe(rng, Math.floor(rng() * 30)),
    repliedThreadCount: maybe(rng, Math.floor(rng() * 20)),
    userInitiatedThreadCount: maybe(rng, Math.floor(rng() * 10)),
    firstSeenAt: maybe(rng, new Date(now.getTime() - 500 * 24 * HOUR).toISOString()),
  };
}

export function genTierOrNull(rng: Rng, p: number): Tier | null {
  return chance(rng, p) ? pick(rng, TIERS) : null;
}
