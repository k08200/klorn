/**
 * The daily briefing's device push under NOTIFY_PUSH_PRESENTATION (NT0 brief
 * copy, decided 2026-11-17): "오늘 브리핑" / "급한 메일 2 · 회의 3 · 빈 시간 5시간".
 *
 *   - urgent mail: Today's "Needs you now" — open PUSH-lane mail received in
 *     the last TODAY_PUSH_WINDOW_HOURS (judge/today-push-window.ts, LOCKED
 *     2026-10-23), one per thread as Today groups it;
 *   - meetings and free hours: the day shape the briefing page shows
 *     (briefing-structure.ts readTodayShape).
 *
 * Counts only: no mail, sender or event text travels in this push. A failed
 * read answers null and the caller sends the old push; so does a morning with
 * no urgent mail and no meeting, where the counts would say nothing and the
 * briefing text says what made it worth a push (new mail, a task due).
 */

import { prisma } from "../db.js";
import { emailThreadKey } from "../judge/firewall-thread-collapse.js";
import { isInTodayPushWindow } from "../judge/today-push-window.js";
import { briefPushCopy, type PushCopy } from "../notify/kind-push-copy.js";
import type { BriefCounts } from "../notify/kind-push-strings.js";
import { getUserNotificationLanguage } from "../notify/notification-strings.js";
import { logDbFailure } from "../report-db-failure.js";
import { getUserTimeZone } from "../user-timezone.js";
import { readTodayShape } from "./briefing-structure.js";

/** Open PUSH mail items read for the count; far above what a morning holds. */
const URGENT_SCAN = 200;
/** The PUSH lane, with its retired v1 name (judge/tiers.ts reads CALL as PUSH). */
const PUSH_TIERS = ["PUSH", "CALL"];

/** Today's PUSH mail, one per thread (Today's grouping), inside Today's window. */
async function countTodayPushMail(userId: string, now: Date): Promise<number> {
  const items = await prisma.attentionItem.findMany({
    where: { userId, status: "OPEN", tier: { in: PUSH_TIERS }, source: "EMAIL" },
    select: { sourceId: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: URGENT_SCAN,
  });
  if (items.length === 0) return 0;
  const mails = await prisma.emailMessage.findMany({
    where: { userId, id: { in: items.map((item) => item.sourceId) } },
    select: { id: true, receivedAt: true, threadId: true, linkedInboxAccountId: true },
  });
  const mailById = new Map(mails.map((mail) => [mail.id, mail]));
  const threads = new Set<string>();
  for (const item of items) {
    const mail = mailById.get(item.sourceId);
    if (!isInTodayPushWindow(mail?.receivedAt ?? null, item.createdAt, now)) continue;
    threads.add(emailThreadKey(mail) ?? `mail:${item.sourceId}`);
  }
  return threads.size;
}

async function briefCounts(userId: string, now: Date): Promise<BriefCounts> {
  const timeZone = await getUserTimeZone(userId);
  const [shape, urgentMail] = await Promise.all([
    readTodayShape(userId, timeZone, now),
    countTodayPushMail(userId, now),
  ]);
  return { urgentMail, meetings: shape.meetingCount, freeHours: shape.freeHours };
}

/** The NT0 brief push; null when its counts could not be read or would say nothing. */
export async function briefingPushCopy(
  userId: string,
  now: Date = new Date(),
): Promise<PushCopy | null> {
  try {
    const [counts, language] = await Promise.all([
      briefCounts(userId, now),
      getUserNotificationLanguage(userId),
    ]);
    if (counts.urgentMail === 0 && counts.meetings === 0) return null;
    return briefPushCopy(counts, language);
  } catch (err) {
    logDbFailure("[BRIEFING] push counts read failed", err, { ids: { userId } });
    return null;
  }
}
