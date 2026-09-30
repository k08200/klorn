/**
 * Proactive reply drafts (2026-09-28): the draft is already there when the
 * user opens a PUSH mail that needs an answer. Superhuman's Auto Drafts,
 * Fyxer and Inbox Zero all do this; Klorn drafted only on demand.
 *
 * Deliberately narrow, because every draft is one LLM call the user did
 * not ask for:
 *   - OFF by default (PROACTIVE_DRAFT_ENABLED) — flipping it is a separate,
 *     deliberate decision;
 *   - PUSH lane only, and only mail the analysis judged needs a reply, that
 *     arrived in the last six hours and has not been answered;
 *   - a per-user daily cap (PROACTIVE_DRAFT_DAILY_CAP, default 5) and at
 *     most two per scheduler tick, on top of the existing cost caps;
 *   - the same entitlement as the on-demand draft route once the paywall
 *     is on;
 *   - one attempt per mail: the attempt is stamped BEFORE the LLM call, so
 *     a failure is never retried in a loop and a second instance skips it.
 *
 * The result is a DRAFT the reading pane offers — nothing here sends.
 */

import { isEntitled } from "../billing/stripe.js";
import { PAYWALL_ENABLED } from "../config.js";
import { prisma } from "../db.js";
import { captureError } from "../sentry.js";

export function isProactiveDraftEnabled(): boolean {
  return process.env.PROACTIVE_DRAFT_ENABLED === "true";
}

const DEFAULT_DAILY_CAP = 5;
const MAX_DAILY_CAP = 20;

/** Operator typo-proof: garbage or < 1 is the default, anything huge is 20. */
export function proactiveDraftDailyCap(): number {
  const parsed = Number(process.env.PROACTIVE_DRAFT_DAILY_CAP);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_DAILY_CAP;
  return Math.min(MAX_DAILY_CAP, Math.floor(parsed));
}

export const PROACTIVE_DRAFT_PER_TICK = 2;
export const PROACTIVE_DRAFT_RECENCY_MS = 6 * 60 * 60 * 1000;
const CANDIDATE_WINDOW = 20;
const DAY_MS = 86_400_000;

export interface DraftCandidate {
  id: string;
  receivedAt: Date;
}

/**
 * Which candidates get a draft this tick — PUSH lane only, newest first,
 * bounded by what is left of the daily cap and by the per-tick limit. Pure,
 * exported for its tests.
 */
export function selectDraftTargets(input: {
  candidates: readonly DraftCandidate[];
  pushIds: ReadonlySet<string>;
  usedToday: number;
  dailyCap: number;
  perTick: number;
}): string[] {
  const budget = Math.min(Math.max(0, input.dailyCap - input.usedToday), input.perTick);
  if (budget <= 0) return [];
  return input.candidates
    .filter((candidate) => input.pushIds.has(candidate.id))
    .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
    .slice(0, budget)
    .map((candidate) => candidate.id);
}

/** Writes one draft for one of the user's emails; null = nothing to write. */
export type DraftBuilder = (userId: string, emailId: string) => Promise<string | null>;

/** Budget errors end the sweep quietly — they are back-pressure, not faults. */
function isBudgetError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "DailyCostCapExceededError" || err.name === "UserRateLimitedError")
  );
}

async function entitledForDrafts(userId: string): Promise<boolean> {
  if (!PAYWALL_ENABLED) return true;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { plan: true, role: true },
  });
  return isEntitled(user?.plan ?? "FREE", user?.role ?? undefined);
}

async function findTargets(userId: string, now: Date): Promise<string[]> {
  const dailyCap = proactiveDraftDailyCap();
  const usedToday = await prisma.emailMessage.count({
    where: { userId, proactiveDraftAt: { gte: new Date(now.getTime() - DAY_MS) } },
  });
  if (usedToday >= dailyCap) return [];
  const candidates = await prisma.emailMessage.findMany({
    where: {
      userId,
      needsReply: true,
      repliedAt: null,
      proactiveDraftAt: null,
      receivedAt: { gte: new Date(now.getTime() - PROACTIVE_DRAFT_RECENCY_MS) },
    },
    select: { id: true, receivedAt: true },
    orderBy: { receivedAt: "desc" },
    take: CANDIDATE_WINDOW,
  });
  if (!candidates.length) return [];
  const pushRows = await prisma.attentionItem.findMany({
    where: {
      userId,
      source: "EMAIL",
      sourceId: { in: candidates.map((candidate) => candidate.id) },
      tier: "PUSH",
    },
    select: { sourceId: true },
  });
  return selectDraftTargets({
    candidates,
    pushIds: new Set(pushRows.map((row) => row.sourceId)),
    usedToday,
    dailyCap,
    perTick: PROACTIVE_DRAFT_PER_TICK,
  });
}

/** One mail: claim it, draft it, store it. False = skipped or empty. */
async function draftOne(
  userId: string,
  emailId: string,
  draftFor: DraftBuilder,
  now: Date,
): Promise<boolean> {
  // Claim first: the stamp is the daily-cap counter AND the retry guard.
  const claimed = await prisma.emailMessage.updateMany({
    where: { id: emailId, userId, proactiveDraftAt: null },
    data: { proactiveDraftAt: now },
  });
  if (claimed.count === 0) return false;
  const draft = (await draftFor(userId, emailId))?.trim();
  if (!draft) return false;
  await prisma.emailMessage.updateMany({
    where: { id: emailId, userId },
    data: { proactiveDraft: draft },
  });
  return true;
}

/**
 * Draft replies ahead of time for this user's fresh PUSH mail. Safe to call
 * every scheduler tick: a no-op while the flag is off, bounded when on, and
 * it never throws — a nicety must not abort the tick that syncs mail.
 * Returns the number of drafts written.
 */
export async function runProactiveDrafts(
  userId: string,
  draftFor: DraftBuilder,
  now: Date = new Date(),
): Promise<number> {
  if (!isProactiveDraftEnabled()) return 0;
  let written = 0;
  try {
    if (!(await entitledForDrafts(userId))) return 0;
    const targets = await findTargets(userId, now);
    for (const emailId of targets) {
      try {
        if (await draftOne(userId, emailId, draftFor, now)) written += 1;
      } catch (err) {
        if (isBudgetError(err)) break;
        console.warn("[PROACTIVE-DRAFT] draft failed:", err instanceof Error ? err.message : err);
        captureError(err, {
          tags: { scope: "proactive-drafts.draft" },
          extra: { userId, emailId },
        });
      }
    }
  } catch (err) {
    console.warn("[PROACTIVE-DRAFT] sweep failed:", err instanceof Error ? err.message : err);
    captureError(err, { tags: { scope: "proactive-drafts.sweep" }, extra: { userId } });
  }
  return written;
}
