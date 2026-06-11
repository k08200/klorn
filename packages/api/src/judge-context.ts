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

import { db } from "./db.js";
import { extractEmailAddress } from "./email-address.js";
import {
  type CorrectionExample,
  EMPTY_JUDGE_CONTEXT,
  type JudgeContext,
  type SenderPrior,
} from "./poc-judge.js";
import { captureError } from "./sentry.js";
import { isManualOverrideReason, isTier, MANUAL_OVERRIDE_PREFIX } from "./tiers.js";

const CORRECTION_POOL_SIZE = 50;
const MAX_FEW_SHOT = 5;
const OVERRIDE_PRIOR_MIN = 2;
const HISTORY_PRIOR_MIN = 3;
const OVERRIDE_PRIOR_MAX_AGE_DAYS = 60;
const HISTORY_PRIOR_MAX_AGE_DAYS = 30;
const SENDER_HISTORY_SAMPLE = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface JudgeContextInput {
  from: string;
  /** EmailMessage.id of the email being judged — excluded from its own prior. */
  excludeEmailId?: string;
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

async function fetchCorrections(
  userId: string,
  senderAddress: string,
): Promise<CorrectionExample[]> {
  const rows = (await db.attentionItem.findMany({
    where: {
      userId,
      source: "EMAIL",
      tierReason: { startsWith: MANUAL_OVERRIDE_PREFIX },
      tier: { not: null },
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

  return rankCorrections(rows, emailsById, senderAddress);
}

function buildPrior(items: SenderItemRow[]): SenderPrior | null {
  const now = Date.now();

  // Strongest signal first: repeated identical manual overrides.
  const overrides = items.filter(
    (i) =>
      isManualOverrideReason(i.tierReason) &&
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

async function fetchSenderPrior(
  userId: string,
  senderAddress: string,
  excludeEmailId?: string,
): Promise<SenderPrior | null> {
  if (!senderAddress) return null;

  const emails = (await db.emailMessage.findMany({
    where: {
      userId,
      from: { contains: senderAddress, mode: "insensitive" },
      ...(excludeEmailId ? { id: { not: excludeEmailId } } : {}),
    },
    orderBy: { receivedAt: "desc" },
    take: SENDER_HISTORY_SAMPLE,
    select: { id: true },
  })) as Array<{ id: string }>;
  if (emails.length === 0) return null;

  const items = (await db.attentionItem.findMany({
    where: { userId, source: "EMAIL", sourceId: { in: emails.map((e) => e.id) } },
    select: { sourceId: true, tier: true, tierReason: true, updatedAt: true },
  })) as SenderItemRow[];
  if (items.length === 0) return null;

  return buildPrior(items);
}

/**
 * Fetch correction few-shots + sender prior for one email. Never throws —
 * a broken correction loop must degrade to plain classification.
 */
export async function buildJudgeContext(
  userId: string,
  input: JudgeContextInput,
): Promise<JudgeContext> {
  try {
    const senderAddress = extractEmailAddress(input.from || "");
    const [corrections, senderPrior] = await Promise.all([
      fetchCorrections(userId, senderAddress),
      fetchSenderPrior(userId, senderAddress, input.excludeEmailId),
    ]);
    return { corrections, senderPrior };
  } catch (err) {
    captureError(err, { tags: { scope: "judge-context" }, extra: { userId } });
    return EMPTY_JUDGE_CONTEXT;
  }
}
