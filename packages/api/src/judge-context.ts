/**
 * Correction-loop context for the 4-tier judge.
 *
 * Closes the loop that PR-#496-era code left open: manual tier overrides
 * were stamped into AttentionItem.tierReason ("Manual override — …") for
 * the POC accuracy gate, but never fed back into classification. This
 * module mines them — no new tables, no migration — into:
 *
 *  - corrections: up to 5 few-shot examples for the judge prompt,
 *    same-sender first, then same-domain, then most recent.
 *  - senderPrior: a per-sender pattern strong enough to skip the LLM
 *    (≥2 identical manual overrides, or ≥3 identical recent
 *    classifications for QUEUE/SILENT). Tier allowlist + urgency guard
 *    live in poc-judge.ts:canShortCircuit.
 *
 * Everything here is best-effort: any DB error returns EMPTY_JUDGE_CONTEXT
 * so classification never blocks on the correction loop.
 */

import { LEARNED_RULES_IN_JUDGE, SENDER_TRAITS_IN_JUDGE } from "./config.js";
import { db } from "./db.js";
import { extractEmailAddress } from "./email-address.js";
import { embedTexts, isEmbeddingEnabled, rankBySimilarity } from "./embedding.js";
import { getCachedInteractionNode } from "./interaction-graph.js";
import { getAppliedRulesForMatch } from "./learned-rule-store.js";
import type { LearnedRule } from "./learned-rules.js";
import { EMPTY_JUDGE_CONTEXT, type JudgeContext } from "./poc-judge.js";
import {
  type CorrectionExample,
  SENDER_PRIOR_POLICY,
  type SenderFacts,
  type SenderPrior,
} from "./sender-policy.js";
import { getActiveSenderTraits, type SenderTraitFact } from "./sender-trait-store.js";
import { captureError } from "./sentry.js";
import { isTier } from "./tiers.js";
import { getTrustScore } from "./trust-score.js";

// Sender-prior thresholds live in sender-policy.ts (the single source). Aliased
// locally for readability where they're used.
const {
  correctionPoolSize: CORRECTION_POOL_SIZE,
  maxFewShot: MAX_FEW_SHOT,
  overrideMin: OVERRIDE_PRIOR_MIN,
  historyMin: HISTORY_PRIOR_MIN,
  overrideMaxAgeDays: OVERRIDE_PRIOR_MAX_AGE_DAYS,
  historyMaxAgeDays: HISTORY_PRIOR_MAX_AGE_DAYS,
  historySample: SENDER_HISTORY_SAMPLE,
} = SENDER_PRIOR_POLICY;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface JudgeContextInput {
  from: string;
  /**
   * Subject of the email being judged. Only used to semantically rank the
   * correction few-shots (embedding.ts) when EMBEDDING_MODEL is set; absent or
   * flag-off falls back to lexical (same-sender/domain/recency) ranking.
   */
  subject?: string;
  /** EmailMessage.id of the email being judged — excluded from its own prior. */
  excludeEmailId?: string;
  /**
   * COUNTERFACTUAL EVAL ONLY (correction-eval.ts): also hide this email's
   * own manual correction from the few-shot pool, so the eval measures
   * "would the judge have gotten it right without the user's fix". The
   * runtime path must NOT set this — re-judging a corrected email is
   * supposed to see its correction; that is the correction loop working.
   */
  excludeOwnCorrection?: boolean;
}

interface OverrideRow {
  sourceId: string;
  tier: string | null;
}

interface EmailRow {
  id: string;
  from: string;
  subject: string;
}

interface SenderItemRow {
  sourceId: string;
  tier: string | null;
  tierReason: string | null;
  isManualOverride: boolean;
  updatedAt: Date;
}

function domainOf(address: string): string | null {
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(at + 1) : null;
}

/**
 * Rank override examples for the prompt: same sender beats same domain
 * beats everything else; ties keep the (already newest-first) query order.
 */
function rankCorrections(
  rows: OverrideRow[],
  emailsById: Map<string, EmailRow>,
  senderAddress: string,
): CorrectionExample[] {
  const senderDomain = domainOf(senderAddress);

  const scored = rows.flatMap((row, index) => {
    const email = emailsById.get(row.sourceId);
    if (!email || !isTier(row.tier)) return [];
    const address = extractEmailAddress(email.from);
    const sameSender = senderAddress.length > 0 && address === senderAddress;
    const sameDomain = senderDomain !== null && domainOf(address) === senderDomain;
    const score = sameSender ? 0 : sameDomain ? 1 : 2;
    return [
      { example: { from: email.from, subject: email.subject, tier: row.tier }, score, index },
    ];
  });

  return scored
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, MAX_FEW_SHOT)
    .map((s) => s.example);
}

/** Text an email contributes to embedding-based ranking (matches the few-shot line). */
function correctionText(from: string, subject: string): string {
  return `${from} ${subject}`.trim();
}

/**
 * Semantically rank the correction pool by cosine similarity of the incoming
 * email to each candidate (embedding.ts), returning the top few-shots. Returns
 * null on any embedding failure (query or all candidates) so the caller falls
 * back to the deterministic lexical ranking — semantic is an enhancement, never
 * a new failure mode.
 */
async function semanticRankCorrections(
  incomingText: string,
  rows: readonly OverrideRow[],
  emailsById: Map<string, EmailRow>,
): Promise<CorrectionExample[] | null> {
  const candidates = rows.flatMap((row) => {
    const email = emailsById.get(row.sourceId);
    if (!email || !isTier(row.tier)) return [];
    return [
      {
        example: { from: email.from, subject: email.subject, tier: row.tier },
        text: correctionText(email.from, email.subject),
      },
    ];
  });
  if (candidates.length === 0) return [];

  const vectors = await embedTexts([incomingText, ...candidates.map((c) => c.text)]);
  const query = vectors[0];
  if (!query) return null; // query embedding failed → lexical fallback
  const candidateVectors = vectors.slice(1);
  const topIdx = rankBySimilarity(query, candidateVectors, MAX_FEW_SHOT);
  if (topIdx.length === 0) return null; // all candidate embeddings failed
  return topIdx.map((i) => candidates[i].example);
}

/**
 * Fail-soft in its OWN try/catch (#677): this used to share the outer
 * buildJudgeContext catch with fetchSenderItems, so a transient error here
 * silently wiped the sender-prior/history context too, not just corrections.
 */
async function fetchCorrections(
  userId: string,
  senderAddress: string,
  excludeSourceId?: string,
  incomingText?: string,
): Promise<CorrectionExample[]> {
  try {
    const rows = (await db.attentionItem.findMany({
      where: {
        userId,
        source: "EMAIL",
        isManualOverride: true,
        tier: { not: null },
        ...(excludeSourceId ? { sourceId: { not: excludeSourceId } } : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: CORRECTION_POOL_SIZE,
      select: { sourceId: true, tier: true },
    })) as OverrideRow[];
    if (rows.length === 0) return [];

    const emails = (await db.emailMessage.findMany({
      where: { id: { in: rows.map((r) => r.sourceId) } },
      select: { id: true, from: true, subject: true },
    })) as EmailRow[];
    const emailsById = new Map(emails.map((e) => [e.id, e]));

    // Semantic ranking when an embedding model is configured and we have the
    // incoming email's text; otherwise (and on any embedding failure) fall back to
    // the deterministic same-sender/domain/recency ranking.
    if (isEmbeddingEnabled() && incomingText) {
      const semantic = await semanticRankCorrections(incomingText, rows, emailsById);
      if (semantic) return semantic;
    }
    return rankCorrections(rows, emailsById, senderAddress);
  } catch (err) {
    console.warn(
      "[judge-context] corrections fetch failed:",
      err instanceof Error ? err.message : String(err),
    );
    captureError(err, { tags: { scope: "judge-context-corrections" }, extra: { userId } });
    return [];
  }
}

function buildPrior(items: SenderItemRow[]): SenderPrior | null {
  const now = Date.now();

  // Strongest signal first: repeated identical manual overrides.
  const overrides = items.filter(
    (i) =>
      i.isManualOverride &&
      isTier(i.tier) &&
      now - i.updatedAt.getTime() <= OVERRIDE_PRIOR_MAX_AGE_DAYS * DAY_MS,
  );
  if (overrides.length >= OVERRIDE_PRIOR_MIN) {
    const tier = overrides[0].tier;
    if (isTier(tier) && overrides.every((o) => o.tier === tier)) {
      return { tier, count: overrides.length, kind: "override" };
    }
  }

  // Otherwise: a unanimous recent history. ALL sampled items must agree —
  // one disagreement means the sender's mail is not homogeneous enough to
  // skip the LLM.
  const recent = items.filter((i) => isTier(i.tier));
  if (recent.length < HISTORY_PRIOR_MIN) return null;
  const newest = recent.reduce((max, i) => Math.max(max, i.updatedAt.getTime()), 0);
  if (now - newest > HISTORY_PRIOR_MAX_AGE_DAYS * DAY_MS) return null;
  const tier = recent[0].tier;
  if (!isTier(tier)) return null;
  if (!recent.every((i) => i.tier === tier)) return null;
  return { tier, count: recent.length, kind: "history" };
}

/**
 * Feature flag (default OFF): when enabled, fetchSenderItems reads the indexed
 * `fromAddress` equality column instead of the unindexable `from` ILIKE
 * substring scan. Read dynamically per call (mirrors poc-judge.isJudgeBodyEnabled)
 * so the founder can flip it via env without a redeploy. MUST stay off until the
 * column is deployed AND `pnpm backfill:from-address` has populated existing rows
 * — an unbackfilled row has fromAddress=null and would silently drop from the
 * equality path, so the flag is the correctness gate.
 */
function isSenderAddressIndexEnabled(): boolean {
  const v = process.env.SENDER_ADDRESS_INDEX_ENABLED?.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Sender-history email ids for this sender, via the indexed fromAddress column. */
async function fetchSenderEmailIdsIndexed(
  userId: string,
  senderAddress: string,
  excludeEmailId?: string,
): Promise<string[]> {
  // Equality on the normalized column (senderAddress is already lowercased, as
  // is the persisted fromAddress) — exact, so no JS re-check is needed.
  const emails = (await db.emailMessage.findMany({
    where: {
      userId,
      fromAddress: senderAddress,
      ...(excludeEmailId ? { id: { not: excludeEmailId } } : {}),
    },
    orderBy: { receivedAt: "desc" },
    take: SENDER_HISTORY_SAMPLE,
    select: { id: true },
  })) as Array<{ id: string }>;
  return emails.map((e) => e.id);
}

/** Sender-history email ids via the legacy `from` ILIKE substring scan. */
async function fetchSenderEmailIdsLegacy(
  userId: string,
  senderAddress: string,
  excludeEmailId?: string,
): Promise<string[]> {
  const emails = (await db.emailMessage.findMany({
    where: {
      userId,
      from: { contains: senderAddress, mode: "insensitive" },
      ...(excludeEmailId ? { id: { not: excludeEmailId } } : {}),
    },
    orderBy: { receivedAt: "desc" },
    take: SENDER_HISTORY_SAMPLE,
    select: { id: true, from: true },
  })) as Array<{ id: string; from: string }>;
  // `contains` is a substring match: querying "alice@corp.com" also matches
  // "malice@corp.com". Re-check the parsed address (extractEmailAddress is
  // lowercased, as is senderAddress) so a different sender that merely shares
  // an address suffix can't contaminate this sender's prior / tier history.
  return emails.filter((e) => extractEmailAddress(e.from) === senderAddress).map((e) => e.id);
}

/**
 * Fail-soft in its OWN try/catch (#677) — see fetchCorrections above for why.
 */
async function fetchSenderItems(
  userId: string,
  senderAddress: string,
  excludeEmailId?: string,
): Promise<SenderItemRow[]> {
  if (!senderAddress) return [];

  try {
    const ownIds = isSenderAddressIndexEnabled()
      ? await fetchSenderEmailIdsIndexed(userId, senderAddress, excludeEmailId)
      : await fetchSenderEmailIdsLegacy(userId, senderAddress, excludeEmailId);
    if (ownIds.length === 0) return [];

    return (await db.attentionItem.findMany({
      where: { userId, source: "EMAIL", sourceId: { in: ownIds } },
      select: {
        sourceId: true,
        tier: true,
        tierReason: true,
        isManualOverride: true,
        updatedAt: true,
      },
    })) as SenderItemRow[];
  } catch (err) {
    console.warn(
      "[judge-context] sender-items fetch failed:",
      err instanceof Error ? err.message : String(err),
    );
    captureError(err, { tags: { scope: "judge-context-sender-items" }, extra: { userId } });
    return [];
  }
}

/**
 * Tier distribution of the sampled sender history. The same rows feed
 * buildPrior — but a mixed history that is too weak for a short-circuit
 * prior is still evidence worth showing the judge (e.g. QUEUE×2, SILENT×1).
 */
function buildTierHistory(
  items: SenderItemRow[],
): { tierHistory: SenderFacts["tierHistory"]; manualOverrides: number } | null {
  const tierHistory: SenderFacts["tierHistory"] = {};
  let manualOverrides = 0;
  for (const item of items) {
    if (!isTier(item.tier)) continue;
    tierHistory[item.tier] = (tierHistory[item.tier] ?? 0) + 1;
    if (item.isManualOverride) manualOverrides++;
  }
  if (Object.keys(tierHistory).length === 0) return null;
  return { tierHistory, manualOverrides };
}

/** Top-contact activity from the cached interaction graph (never rebuilds). */
async function fetchInteractionFact(
  userId: string,
  senderAddress: string,
): Promise<SenderFacts["interaction"]> {
  if (!senderAddress) return null;
  const node = await getCachedInteractionNode(userId, senderAddress);
  if (!node) return null;
  return {
    emailCount: node.emailCount,
    lastEmailDaysAgo: node.lastEmailDaysAgo,
    upcomingMeetings: node.upcomingMeetings,
  };
}

/** Commitment track record — only when the badge is load-bearing (≥3 fresh data points). */
async function fetchCommitmentFact(
  userId: string,
  senderAddress: string,
): Promise<SenderFacts["commitments"]> {
  if (!senderAddress) return null;
  const score = await getTrustScore(userId, senderAddress);
  if (!score || score.badge === "unknown") return null;
  return { onTime: score.onTimeCount, total: score.totalCount };
}

/**
 * Extracted sender traits for judge grounding (Phase 3b). Flag-gated
 * (SENDER_TRAITS_IN_JUDGE, default off) and fail-soft in its OWN try/catch:
 * a trait-query error logs a signal and returns [] rather than bubbling to the
 * outer catch, so a trait outage never costs the correction loop.
 */
async function fetchSenderTraits(
  userId: string,
  senderAddress: string,
): Promise<SenderTraitFact[]> {
  if (!SENDER_TRAITS_IN_JUDGE || !senderAddress) return [];
  try {
    return await getActiveSenderTraits(userId, senderAddress);
  } catch (err) {
    // Log the message only — a raw Prisma error can embed the sender address
    // (PII) in its meta; captureError still gets the full error for Sentry.
    console.warn(
      "[judge-context] sender-trait fetch failed:",
      err instanceof Error ? err.message : String(err),
    );
    captureError(err, { tags: { scope: "judge-context-traits" }, extra: { userId } });
    return [];
  }
}

/**
 * APPLIED learned rules for judge short-circuiting (Slice 4). Flag-gated
 * (LEARNED_RULES_IN_JUDGE, default off) and fail-soft in its OWN try/catch: a
 * rule-query error logs a signal and returns [] rather than bubbling to the
 * outer catch, so a rule outage never costs the correction loop. Returns ALL
 * the user's APPLIED rules; the per-email match runs in poc-judge.
 */
async function fetchLearnedRules(userId: string): Promise<LearnedRule[]> {
  if (!LEARNED_RULES_IN_JUDGE) return [];
  try {
    return await getAppliedRulesForMatch(userId);
  } catch (err) {
    console.warn(
      "[judge-context] learned-rule fetch failed:",
      err instanceof Error ? err.message : String(err),
    );
    captureError(err, { tags: { scope: "judge-context-learned-rules" }, extra: { userId } });
    return [];
  }
}

/**
 * Fetch correction few-shots, sender prior, and sender facts for one email.
 * Never throws — a broken correction loop must degrade to plain
 * classification. All six Promise.all branches are now independently
 * fail-soft (#677): fetchCorrections and fetchSenderItems catch in their own
 * try/catch, same as fetchSenderTraits/fetchLearnedRules; getCachedInteractionNode
 * and getTrustScore are internally fail-soft. A transient error in ANY one
 * branch no longer wipes the other five — this outer catch now only fires on
 * something outside those six calls (e.g. extractEmailAddress throwing).
 */
export async function buildJudgeContext(
  userId: string,
  input: JudgeContextInput,
): Promise<JudgeContext> {
  try {
    const senderAddress = extractEmailAddress(input.from || "");
    const correctionExcludeId =
      input.excludeOwnCorrection && input.excludeEmailId ? input.excludeEmailId : undefined;
    // Only build the embedding query text when the feature is on — keeps the
    // no-embedding path (and the eval gate) byte-identical.
    const incomingText = isEmbeddingEnabled()
      ? correctionText(input.from || "", input.subject || "")
      : undefined;
    const [corrections, senderItems, interaction, commitments, senderTraits, learnedRules] =
      await Promise.all([
        fetchCorrections(userId, senderAddress, correctionExcludeId, incomingText),
        fetchSenderItems(userId, senderAddress, input.excludeEmailId),
        fetchInteractionFact(userId, senderAddress),
        fetchCommitmentFact(userId, senderAddress),
        fetchSenderTraits(userId, senderAddress),
        fetchLearnedRules(userId),
      ]);

    const senderPrior = senderItems.length > 0 ? buildPrior(senderItems) : null;
    const history = buildTierHistory(senderItems);
    const senderFacts: SenderFacts | null =
      history || interaction || commitments
        ? {
            tierHistory: history?.tierHistory ?? {},
            manualOverrides: history?.manualOverrides ?? 0,
            interaction,
            commitments,
          }
        : null;

    return { corrections, senderPrior, senderFacts, senderTraits, learnedRules };
  } catch (err) {
    captureError(err, { tags: { scope: "judge-context" }, extra: { userId } });
    return EMPTY_JUDGE_CONTEXT;
  }
}
