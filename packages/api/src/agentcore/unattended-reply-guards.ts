/**
 * Guards shared by both unattended send paths: AUTO_REPLY rules
 * (automation-scheduler.ts runRuleAutoReply) and auto-mode
 * (agentcore/auto-mode-sweep.ts). Both send an LLM-written reply with no
 * per-message approval, so both stop, before any LLM spend, when:
 *
 *   - the mail is machine or list mail: a reply is useless at best and an
 *     auto-responder loop or a mail to a whole list at worst. Only what is
 *     stored is checked: List-Unsubscribe (Gmail rows), the judge's automated
 *     sender heuristic, and the loop-prone local parts below. Auto-Submitted,
 *     Precedence and List-Id are not stored, so RFC 3834 is followed only in
 *     spirit;
 *   - the reply would go to one of the user's own addresses (a self-send loop);
 *   - MAX_UNATTENDED_REPLIES_PER_DAY replies were already claimed today (UTC).
 *     The count includes failed and in-flight claims: each was a send attempt.
 *     It is read before the claim, so overlapping ticks can overshoot by the
 *     few mails already in flight. When it stops a reply, the user gets one
 *     visible notice that day.
 */

import { prisma } from "../db.js";
import { isAutomatedSender } from "../judge/keyword-policy.js";
import { extractEmailAddress } from "../mail/email-address.js";
import { REPLY_LEDGER_PREFIX } from "./auto-reply-ledger-keys.js";

export const MAX_UNATTENDED_REPLIES_PER_DAY = 20;
// Must not start with REPLY_LEDGER_PREFIX, or the notice would count itself.
const CAP_NOTICE_PREFIX = "auto-reply-cap:";
const UTC_DAY_KEY_LENGTH = 10;
// Local parts of machine senders that answer mail themselves or bounce it,
// which isAutomatedSender (built for the judge) does not cover. Anchored, one
// alternation, no nested quantifier: linear on any input.
const LOOP_PRONE_LOCAL_PART =
  /^(?:mailer-daemon|postmaster|do[-_.]?not[-_.]?reply|no[-_.]?reply|bounces?|auto[-_.]?(?:reply|responder|confirm)|autoresponder|notify|alerts?)(?:$|[+._-])/;

export type UnattendedReplyBlock = "machine-or-list" | "own-address" | "daily-cap";

export interface GuardEmail {
  from: string;
  listUnsubscribeUrl?: string | null;
  listUnsubscribeMailto?: string | null;
}

export function isMachineOrListMail(email: GuardEmail): boolean {
  if (email.listUnsubscribeUrl || email.listUnsubscribeMailto) return true;
  if (isAutomatedSender(email.from)) return true;
  const address = extractEmailAddress(email.from);
  const local = address.slice(0, Math.max(0, address.lastIndexOf("@")));
  return LOOP_PRONE_LOCAL_PART.test(local);
}

async function isOwnAddress(userId: string, address: string): Promise<boolean> {
  const [user, linked] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
    prisma.linkedInboxAccount.findMany({ where: { userId }, select: { email: true } }),
  ]);
  const own = [user?.email, ...linked.map((account) => account.email)];
  return own.some((mine) => typeof mine === "string" && mine.toLowerCase() === address);
}

function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Unattended reply claims (rule and auto-mode share the key) since UTC midnight. */
export async function unattendedRepliesToday(
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  return prisma.notification.count({
    where: {
      userId,
      dedupeKey: { startsWith: REPLY_LEDGER_PREFIX },
      createdAt: { gte: utcDayStart(now) },
    },
  });
}

async function noteDailyCap(userId: string, now: Date): Promise<void> {
  const day = now.toISOString().slice(0, UTC_DAY_KEY_LENGTH);
  try {
    await prisma.notification.create({
      data: {
        userId,
        type: "email",
        isRead: false,
        dedupeKey: `${CAP_NOTICE_PREFIX}${day}`,
        title: "Auto-replies paused for today",
        message: `Klorn already sent ${MAX_UNATTENDED_REPLIES_PER_DAY} automatic replies today, the daily limit. Matching mail waits in your inbox until tomorrow (UTC).`,
      },
    });
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code !== "P2002") console.warn("[AUTOMATION] auto-reply cap notice failed:", err);
  }
}

/** Why an unattended reply to `email` must not be sent, or null when it may. */
export async function unattendedReplyBlock(
  userId: string,
  email: GuardEmail,
  now: Date = new Date(),
): Promise<UnattendedReplyBlock | null> {
  if (isMachineOrListMail(email)) return "machine-or-list";
  const address = extractEmailAddress(email.from);
  if (address && (await isOwnAddress(userId, address))) return "own-address";
  if ((await unattendedRepliesToday(userId, now)) >= MAX_UNATTENDED_REPLIES_PER_DAY) {
    await noteDailyCap(userId, now);
    return "daily-cap";
  }
  return null;
}
