/**
 * Screener — the first-contact gate.
 *
 * HEY's Screener and Spark's Gatekeeper both answer a question Klorn's ladder
 * never asked: *should this person be able to reach me at all?* Everything in
 * `poc-judge.judgeEmail` assumes the sender is already legitimate and only
 * argues about which lane they land in. For a sender you have never heard from,
 * that is the wrong first question, and answering it with a model call costs
 * money on exactly the mail where the model has the least evidence.
 *
 * Two deliberate limits, both doctrine rather than convenience:
 *
 *   1. **No sixth lane.** `product-vocabulary.md` fixes the list at five, and a
 *      screener is not a lane — it is a decision *about a sender*. A BLOCK is
 *      written as a `PIN_TIER -> SILENT` rule, which the judge already honours
 *      at rank 0, above even the marketing fast-path. Nothing new to enforce.
 *
 *   2. **Nothing is held.** HEY parks unscreened mail until you rule on it. If
 *      you ignore Klorn's screener, mail still gets classified and delivered
 *      exactly as it does today; the screener only ever *adds* a permanent
 *      shortcut. A gate that can silently strand mail is a worse failure than
 *      the noise it prevents.
 *
 * Off by default behind `SCREENER_ENABLED`, per the flag doctrine in CLAUDE.md.
 */

import { db } from "../db.js";
import { captureError } from "../sentry.js";

export type ScreenerVerdict = "ALLOW" | "BLOCK";

export interface PendingSender {
  sender: string;
  messageCount: number;
  lastReceivedAt: Date | null;
}

/**
 * How far back `listPendingScreener` looks for new senders.
 *
 * This bound is load-bearing, not tuning. Linking an inbox backfills the
 * mailbox, and during that backfill *every* sender is technically a first
 * contact — without a window the screener would open on day one with a
 * thousand entries and be abandoned immediately. Only senders whose first
 * message is recent are worth a decision.
 */
const PENDING_WINDOW_DAYS = 30;

/** Never ask the user to rule on more senders than one sitting can absorb. */
const PENDING_LIMIT = 50;

/**
 * Most recent undecided senders checked against history per call. Bounds the
 * `IN (...)` list on a heavy mailbox; newest senders are checked first, so the
 * cap only ever drops the oldest candidates.
 */
const MAX_CANDIDATES_CHECKED = 500;

function normalizeSender(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Rule name that marks a pin as screener-authored, so ALLOW can undo exactly it. */
function blockRuleName(sender: string): string {
  return `Screener block: ${sender}`;
}

export function isScreenerEnabled(): boolean {
  return process.env.SCREENER_ENABLED === "true";
}

/**
 * Has this user ever received mail from this address before?
 *
 * Fails open to `false` (treat as known). A DB blip must never reclassify the
 * user's entire correspondence as strangers — that would flood the screener
 * with people they have talked to for years.
 */
export async function isFirstContact(userId: string, fromAddress: string): Promise<boolean> {
  const sender = normalizeSender(fromAddress || "");
  if (!sender) return false;
  try {
    const seen = await db.emailMessage.count({
      where: { userId, fromAddress: sender },
      take: 1,
    });
    return seen === 0;
  } catch (err) {
    console.warn(
      "[screener] first-contact lookup failed:",
      err instanceof Error ? err.message : String(err),
    );
    captureError(err, { tags: { scope: "screener-first-contact" }, extra: { userId } });
    return false;
  }
}

/** The user's standing decision about this sender, or null if never screened. */
export async function screenerVerdictFor(
  userId: string,
  sender: string,
): Promise<ScreenerVerdict | null> {
  const address = normalizeSender(sender || "");
  if (!address) return null;
  try {
    const row = await db.screenerDecision.findUnique({
      where: { userId_sender: { userId, sender: address } },
      select: { verdict: true },
    });
    return (row?.verdict as ScreenerVerdict | undefined) ?? null;
  } catch (err) {
    console.warn(
      "[screener] verdict lookup failed:",
      err instanceof Error ? err.message : String(err),
    );
    captureError(err, { tags: { scope: "screener-verdict" }, extra: { userId } });
    return null;
  }
}

/**
 * Record a permanent decision about a sender.
 *
 * BLOCK additionally writes the `PIN_TIER -> SILENT` rule that actually does the
 * work; ALLOW removes any pin a previous BLOCK created, so the pair is properly
 * reversible. ALLOW deliberately does NOT pin a tier — the user said "this
 * person is real", not "always show me this at PUSH". The classifier keeps its
 * job.
 *
 * Unlike the read paths above this does not fail open: a decision the user
 * believes they made, that silently did not persist, is worse than an error.
 */
export async function recordScreenerDecision(
  userId: string,
  sender: string,
  verdict: ScreenerVerdict,
): Promise<void> {
  const address = normalizeSender(sender || "");
  if (!address) throw new Error("screener: sender address is required");

  if (verdict === "BLOCK") {
    await db.emailRule.create({
      data: {
        userId,
        name: blockRuleName(address),
        description: "Created by the screener when you blocked this sender.",
        isActive: true,
        conditions: { from: [address] },
        actionType: "PIN_TIER",
        actionValue: "SILENT",
      },
    });
  } else {
    await db.emailRule.deleteMany({
      where: { userId, actionType: "PIN_TIER", name: blockRuleName(address) },
    });
  }

  await db.screenerDecision.upsert({
    where: { userId_sender: { userId, sender: address } },
    create: { userId, sender: address, verdict },
    update: { verdict, decidedAt: new Date() },
  });
}

/**
 * Senders waiting for a first-contact decision, newest first.
 *
 * Fails open to an empty list: an empty screener is a screener with nothing to
 * do, which is a safe thing to show. A half-built list would invite the user to
 * make decisions on a set that is silently wrong.
 */
export async function listPendingScreener(
  userId: string,
  limit: number = PENDING_LIMIT,
): Promise<PendingSender[]> {
  const cutoff = new Date(Date.now() - PENDING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  try {
    const grouped = await db.emailMessage.groupBy({
      by: ["fromAddress"],
      where: { userId, receivedAt: { gte: cutoff }, fromAddress: { not: null } },
      _count: { _all: true },
      _max: { receivedAt: true },
    });

    const candidates = (grouped as GroupedSender[])
      .map((g) => ({
        sender: normalizeSender(g.fromAddress ?? ""),
        messageCount: g._count?._all ?? 0,
        lastReceivedAt: g._max?.receivedAt ?? null,
      }))
      .filter((c) => c.sender.length > 0)
      .sort((a, b) => (b.lastReceivedAt?.getTime() ?? 0) - (a.lastReceivedAt?.getTime() ?? 0));

    if (candidates.length === 0) return [];

    const decided = await db.screenerDecision.findMany({
      where: { userId, sender: { in: candidates.map((c) => c.sender) } },
      select: { sender: true },
    });
    const decidedSet = new Set((decided as { sender: string }[]).map((d) => d.sender));

    const undecided = candidates
      .filter((c) => !decidedSet.has(c.sender))
      .slice(0, MAX_CANDIDATES_CHECKED);
    if (undecided.length === 0) return [];

    // The window above says "wrote recently"; first contact means the sender's
    // FIRST message is recent too. Any mail from them before the window makes
    // them a long-standing sender who simply went quiet, never a stranger.
    // (Checking "no messages at all" here can never pass: every candidate came
    // from the groupBy above, so each has at least one.)
    const prior = await db.emailMessage.findMany({
      where: {
        userId,
        fromAddress: { in: undecided.map((c) => c.sender) },
        receivedAt: { lt: cutoff },
      },
      select: { fromAddress: true },
      distinct: ["fromAddress"],
    });
    const knownBefore = new Set(
      (prior as { fromAddress: string | null }[]).map((p) => normalizeSender(p.fromAddress ?? "")),
    );
    return undecided.filter((c) => !knownBefore.has(c.sender)).slice(0, limit);
  } catch (err) {
    console.warn(
      "[screener] pending list failed:",
      err instanceof Error ? err.message : String(err),
    );
    captureError(err, { tags: { scope: "screener-pending" }, extra: { userId } });
    return [];
  }
}

interface GroupedSender {
  fromAddress: string | null;
  _count?: { _all?: number };
  _max?: { receivedAt?: Date | null };
}
