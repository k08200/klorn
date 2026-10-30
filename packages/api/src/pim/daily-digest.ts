/**
 * Daily digest — the safety net for everything Klorn filed away.
 *
 * SILENT and INFO are the lanes that make the firewall worth having, and they
 * are also the only ones the user cannot check by glancing at their inbox.
 * "Filed, not deleted" is a promise, and a promise nobody can audit is just an
 * assertion. SaneBox has shipped a daily digest since 2010 for exactly this
 * reason: it is the mechanism that makes suppression trustworthy.
 *
 * Distinct from the weekly signal report on purpose:
 *
 *   - The weekly report answers *how did triage go* — measured lane counts,
 *     corrections, auto-actions — and it goes out as a push.
 *   - This answers *did you hide something I needed*, names the senders, and
 *     goes out as EMAIL. Email is the one channel that reaches a user with no
 *     app open and no push permission granted, which is the whole point of a
 *     safety net.
 *
 * Both are digest-class content, so both are governed by the single
 * `daily_briefing` preference rather than growing a second switch. That
 * preference is also what this mail's opt-out points at (mail/email.ts): a
 * recurring mail needs a working way out, and the switch the user can already
 * see in settings is that way out — not a second, invisible suppression list.
 *
 * No LLM and no estimates. The weekly report deliberately refuses to claim
 * "time saved" because we do not measure it; the same rule applies here.
 *
 * Copy is en/ko only, and every other notification language falls back to
 * English. Klorn ships seven; writing five more sets of user-facing email copy
 * unreviewed would be worse than an honest fallback, so the remaining
 * translations go through the normal i18n lane rather than being invented here.
 *
 * Off by default behind `DAILY_DIGEST_ENABLED`.
 */

import { prisma } from "../db.js";
import { isScreenerEnabled, listPendingScreener } from "../judge/screener.js";
import { sendDigestEmail } from "../mail/email.js";
import { evaluateNotificationGate } from "../notify/notification-prefs.js";
import {
  getUserNotificationLanguage,
  type NotificationLanguage,
} from "../notify/notification-strings.js";
import { captureError } from "../sentry.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Where the digest points when it has something for the user to act on. */
const WEB_URL = process.env.WEB_URL || "https://app.klorn.ai";

/**
 * How many senders the mail names. A digest long enough to scroll is a digest
 * nobody reads; the headline count still reports the true total, so capping the
 * list never hides how much was filed.
 */
const SENDER_LIMIT = 10;

export interface DigestSender {
  sender: string;
  count: number;
}

export interface DigestStats {
  /** Everything filed to SILENT/INFO in the window — not just the named senders. */
  filed: number;
  senders: DigestSender[];
  /**
   * How many first-contact senders are waiting on a screener ruling. Zero when
   * the screener is off, so the digest simply never mentions it.
   */
  pendingScreener: number;
}

/** UTC calendar date, e.g. "2026-08-23". Pure; used as the once-per-day key. */
export function dayKeyUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function isDailyDigestEnabled(): boolean {
  return process.env.DAILY_DIGEST_ENABLED === "true";
}

/**
 * What was filed out of the user's way in the last 24 hours.
 *
 * Reads the DecisionLabel ledger rather than AttentionItem: the ledger records
 * what was actually SHOWN at judge time, which is the thing the user is being
 * reassured about. A later correction changes the item, but it does not change
 * the fact that this is what got filed today.
 */
export async function collectDigest(userId: string, now: Date): Promise<DigestStats> {
  const since = new Date(now.getTime() - DAY_MS);
  const where = {
    userId,
    judgedAt: { gte: since },
    shownTier: { in: ["SILENT", "INFO"] },
  };

  const [grouped, filed] = await Promise.all([
    prisma.decisionLabel.groupBy({
      by: ["sender"],
      where,
      _count: { _all: true },
    }),
    prisma.decisionLabel.count({ where }),
  ]);

  const senders = (grouped as { sender: string | null; _count?: { _all?: number } }[])
    .map((row) => ({ sender: (row.sender ?? "").trim(), count: row._count?._all ?? 0 }))
    .filter((row) => row.sender.length > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, SENDER_LIMIT);

  // The screener is a separate, independently-flagged feature. Ask it nothing
  // when it is off, and never let its failure cost the user their digest — the
  // digest's own job (what got filed) does not depend on it.
  let pendingScreener = 0;
  if (isScreenerEnabled()) {
    try {
      pendingScreener = (await listPendingScreener(userId)).length;
    } catch (err) {
      console.warn(
        "[digest] screener lookup failed, sending without it:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return { filed, senders, pendingScreener };
}

interface DigestCopy {
  subject: (n: number) => string;
  lead: (n: number) => string;
  from: string;
  more: string;
  screener: (n: number) => string;
}

const COPY: Record<"en" | "ko", DigestCopy> = {
  en: {
    subject: (n: number) => `Klorn filed ${n} message${n === 1 ? "" : "s"} today`,
    lead: (n: number) =>
      `${n} message${n === 1 ? "" : "s"} went to Silent or Info in the last 24 hours. ` +
      `Filed, not deleted — everything below is still in your mailbox.`,
    from: "Who they were from:",
    more: "Nothing here looks wrong? Then there is nothing to do.",
    screener: (n: number) =>
      `${n} sender${n === 1 ? "" : "s"} wrote for the first time and ${n === 1 ? "is" : "are"} ` +
      `waiting on a ruling. Deciding once is permanent: ${WEB_URL}/inbox`,
  },
  ko: {
    subject: (n: number) => `Klorn이 오늘 ${n}통을 정리했습니다`,
    lead: (n: number) =>
      `지난 24시간 동안 ${n}통이 Silent 또는 Info로 갔습니다. ` +
      `지운 게 아니라 정리한 것이라, 아래 메일은 전부 메일함에 그대로 있습니다.`,
    from: "보낸 사람:",
    more: "이상한 게 없다면, 하실 일도 없습니다.",
    screener: (n: number) =>
      `처음 온 발신자 ${n}명이 판단을 기다리고 있습니다. 한 번 정하면 계속 적용됩니다: ${WEB_URL}/inbox`,
  },
};

/** en/ko are written; the other five ship languages fall back to English. */
function copyFor(language: NotificationLanguage): DigestCopy {
  return language === "ko" ? COPY.ko : COPY.en;
}

/** Plain text body. Density over decoration, matching the weekly report. */
export function formatDigest(stats: DigestStats, language: NotificationLanguage): string {
  const c = copyFor(language);
  const lines = [c.lead(stats.filed)];
  if (stats.senders.length > 0) {
    lines.push("", c.from);
    for (const s of stats.senders) lines.push(`  ${s.sender} — ${s.count}`);
  }
  if (stats.pendingScreener > 0) lines.push("", c.screener(stats.pendingScreener));
  lines.push("", c.more);
  return lines.join("\n");
}

export function digestSubject(stats: DigestStats, language: NotificationLanguage): string {
  return copyFor(language).subject(stats.filed);
}

/**
 * One digest per user per UTC day.
 *
 * The Note row is created BEFORE the mail goes out, not after. Its
 * (userId, dayKey) unique constraint is what makes the sweep idempotent, and
 * claiming the day first means a crash between "sent" and "recorded" costs the
 * user nothing, while the reverse order would mail them twice. For a digest,
 * a missed day is a smaller failure than a duplicate.
 */
export async function sendDailyDigests(now: Date = new Date()): Promise<number> {
  if (!isDailyDigestEnabled()) return 0;

  const dayKey = dayKeyUtc(now);
  const users = (await prisma.user.findMany({
    select: { id: true, email: true },
  })) as { id: string; email: string | null }[];

  let sent = 0;
  for (const user of users) {
    try {
      if (!user.email) continue;

      const stats = await collectDigest(user.id, now);
      // An empty digest is noise, not a safety net.
      if (stats.filed === 0) continue;

      const gate = await evaluateNotificationGate(user.id, "daily_briefing");
      if (!gate.allowed) continue;

      try {
        await prisma.note.create({
          data: {
            userId: user.id,
            dayKey,
            title: `Daily digest — ${dayKey}`,
            content: formatDigest(stats, "en"),
            category: "digest",
          },
          select: { id: true },
        });
      } catch (err) {
        // Already claimed today — another tick (or a restart) got here first.
        if ((err as { code?: string })?.code === "P2002") continue;
        throw err;
      }

      const language = await getUserNotificationLanguage(user.id);
      // The language also picks the opt-out wording in the mail's footer and
      // text part, so it is passed rather than left to the "en" default.
      await sendDigestEmail(
        user.email,
        digestSubject(stats, language),
        formatDigest(stats, language),
        language,
      );
      sent++;
    } catch (err) {
      // One user's bad address or provider blip must not end the sweep.
      console.warn(`[DIGEST] daily digest failed for user ${user.id}:`, err);
      captureError(err, { tags: { scope: "daily-digest" }, extra: { userId: user.id } });
    }
  }
  return sent;
}
