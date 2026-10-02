/**
 * Proactive reply drafts (2026-09-28): the draft is already there when the
 * user opens a PUSH mail that needs an answer. Superhuman's Auto Drafts,
 * Fyxer and Inbox Zero all do this; Klorn drafted only on demand.
 *
 * Deliberately narrow, because every draft is one LLM call the user did
 * not ask for:
 *   - OFF by default (PROACTIVE_DRAFT_ENABLED) — flipping it is a separate,
 *     deliberate decision;
 *   - PUSH lane only (an OPEN attention item), and only mail the analysis
 *     judged needs a reply, that arrived in the last six hours and has not
 *     been answered;
 *   - a HARD per-user cap per UTC day (PROACTIVE_DRAFT_DAILY_CAP, default
 *     5): a slot is reserved with an atomic conditional increment on the
 *     user row before anything else happens, so overlapping sweeps or a
 *     second instance cannot overshoot it and deleting mail cannot refill
 *     it. At most two per sweep, on top of the existing cost caps;
 *   - the same entitlement as the on-demand draft route once the paywall
 *     is on;
 *   - one attempt per mail: the attempt is stamped BEFORE the LLM call with
 *     a guarded update, so a failure is never retried in a loop and a second
 *     instance skips it. The one exception is back-pressure (cost cap, rate
 *     limit, every provider down) — nothing was generated, so the mail and
 *     the slot are handed back and the user's sweeps pause for a while.
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

export const PROACTIVE_DRAFT_PER_SWEEP = 2;
export const PROACTIVE_DRAFT_RECENCY_MS = 6 * 60 * 60 * 1000;
export const PROACTIVE_DRAFT_BACKOFF_MS = 15 * 60 * 1000;
const PUSH_WINDOW = 50;
/** "CALL" is the retired v1 name normalizeTier folds into PUSH on read. */
const PUSH_TIERS = ["PUSH", "CALL"];

/** The cap's window: one UTC calendar day. */
export function draftDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Writes one draft for one of the user's emails; null = nothing to write. */
export type DraftBuilder = (userId: string, emailId: string) => Promise<string | null>;

// Per-instance sweep state. The hard bounds live in the database (the slot
// counter and the per-mail stamp); these only keep one instance from
// stacking sweeps for a user or hammering a provider that is refusing.
const sweeping = new Set<string>();
const pausedUntil = new Map<string, number>();

export function resetProactiveDraftStateForTests(): void {
  sweeping.clear();
  pausedUntil.clear();
}

/** Nothing was generated and retrying now cannot help — back off, don't alert. */
const BACK_PRESSURE_ERRORS = new Set([
  "DailyCostCapExceededError",
  "UserRateLimitedError",
  "AllProvidersExhaustedError",
]);

function isBackPressure(err: unknown): boolean {
  return err instanceof Error && BACK_PRESSURE_ERRORS.has(err.name);
}

/**
 * Take one of today's slots. Atomic: the increment only applies while the
 * stored count is under the cap, and the day rollover only applies while
 * the stored day is stale — so concurrent callers can never both win the
 * last slot.
 */
async function reserveSlot(userId: string, day: string): Promise<boolean> {
  const increment = () =>
    prisma.user.updateMany({
      where: {
        id: userId,
        proactiveDraftDay: day,
        proactiveDraftCount: { lt: proactiveDraftDailyCap() },
      },
      data: { proactiveDraftCount: { increment: 1 } },
    });
  if ((await increment()).count === 1) return true;
  const rolled = await prisma.user.updateMany({
    where: { id: userId, OR: [{ proactiveDraftDay: null }, { proactiveDraftDay: { not: day } }] },
    data: { proactiveDraftDay: day, proactiveDraftCount: 1 },
  });
  if (rolled.count === 1) return true;
  // Lost the rollover to a concurrent sweep, or today's cap is spent.
  return (await increment()).count === 1;
}

async function releaseSlot(userId: string, day: string): Promise<void> {
  await prisma.user.updateMany({
    where: { id: userId, proactiveDraftDay: day, proactiveDraftCount: { gt: 0 } },
    data: { proactiveDraftCount: { decrement: 1 } },
  });
}

async function entitledForDrafts(userId: string): Promise<boolean> {
  if (!PAYWALL_ENABLED) return true;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { plan: true, role: true },
  });
  return isEntitled(user?.plan ?? "FREE", user?.role ?? undefined);
}

/** Fresh, unanswered, never-attempted PUSH mail that needs a reply — newest first. */
async function findTargets(userId: string, now: Date): Promise<string[]> {
  // PUSH first: it is the narrow side, so a pile of QUEUE mail that also
  // needs a reply can never crowd the PUSH ones out of a window.
  const pushRows = await prisma.attentionItem.findMany({
    where: { userId, source: "EMAIL", status: "OPEN", tier: { in: PUSH_TIERS } },
    select: { sourceId: true },
    orderBy: { surfacedAt: "desc" },
    take: PUSH_WINDOW,
  });
  if (!pushRows.length) return [];
  const emails = await prisma.emailMessage.findMany({
    where: {
      userId,
      id: { in: pushRows.map((row) => row.sourceId) },
      needsReply: true,
      repliedAt: null,
      proactiveDraftAt: null,
      receivedAt: { gte: new Date(now.getTime() - PROACTIVE_DRAFT_RECENCY_MS) },
    },
    select: { id: true },
    orderBy: { receivedAt: "desc" },
    take: PROACTIVE_DRAFT_PER_SWEEP,
  });
  return emails.map((email) => email.id);
}

type DraftOutcome = "written" | "empty" | "taken" | "capReached" | "backPressure";

/** One mail: reserve a slot, claim the mail, draft it, store it. */
async function draftOne(
  userId: string,
  emailId: string,
  draftFor: DraftBuilder,
  now: Date,
): Promise<DraftOutcome> {
  const day = draftDayKey(now);
  if (!(await reserveSlot(userId, day))) return "capReached";
  // The stamp is the retry guard: only the caller that flips it from null
  // gets to draft this mail.
  const claimed = await prisma.emailMessage.updateMany({
    where: { id: emailId, userId, proactiveDraftAt: null },
    data: { proactiveDraftAt: now },
  });
  if (claimed.count === 0) {
    await releaseSlot(userId, day);
    return "taken";
  }
  let draft: string | undefined;
  try {
    draft = (await draftFor(userId, emailId))?.trim();
  } catch (err) {
    if (!isBackPressure(err)) throw err;
    // Nothing was generated: hand back the mail and the slot.
    await prisma.emailMessage.updateMany({
      where: { id: emailId, userId, proactiveDraftAt: now },
      data: { proactiveDraftAt: null },
    });
    await releaseSlot(userId, day);
    return "backPressure";
  }
  if (!draft) return "empty";
  await prisma.emailMessage.updateMany({
    where: { id: emailId, userId },
    data: { proactiveDraft: draft },
  });
  return "written";
}

async function sweep(userId: string, draftFor: DraftBuilder, now: Date): Promise<number> {
  const targets = await findTargets(userId, now);
  if (!targets.length) return 0;
  if (!(await entitledForDrafts(userId))) return 0;
  let written = 0;
  for (const emailId of targets) {
    try {
      const outcome = await draftOne(userId, emailId, draftFor, now);
      if (outcome === "written") written += 1;
      if (outcome === "capReached") break;
      if (outcome === "backPressure") {
        pausedUntil.set(userId, now.getTime() + PROACTIVE_DRAFT_BACKOFF_MS);
        break;
      }
    } catch (err) {
      // A real fault on this mail: its attempt stays spent, the next mail runs.
      console.warn("[PROACTIVE-DRAFT] draft failed:", err instanceof Error ? err.message : err);
      captureError(err, { tags: { scope: "proactive-drafts.draft" }, extra: { userId, emailId } });
    }
  }
  return written;
}

/**
 * Draft replies ahead of time for this user's fresh PUSH mail. Safe to call
 * every scheduler tick: a no-op while the flag is off, bounded when on, and
 * it never throws — a nicety must not disturb the tick that syncs mail.
 * Returns the number of drafts written.
 */
export async function runProactiveDrafts(
  userId: string,
  draftFor: DraftBuilder,
  now: Date = new Date(),
): Promise<number> {
  if (!isProactiveDraftEnabled()) return 0;
  if (sweeping.has(userId)) return 0;
  if ((pausedUntil.get(userId) ?? 0) > now.getTime()) return 0;
  pausedUntil.delete(userId);
  sweeping.add(userId);
  try {
    return await sweep(userId, draftFor, now);
  } catch (err) {
    console.warn("[PROACTIVE-DRAFT] sweep failed:", err instanceof Error ? err.message : err);
    captureError(err, { tags: { scope: "proactive-drafts.sweep" }, extra: { userId } });
    return 0;
  } finally {
    sweeping.delete(userId);
  }
}
