/**
 * Evening review (`eod_review`): one push before the user closes the day, and
 * ONLY when something is still open.
 *
 * The previous version always sent at EOD_HOUR: today's completed-task count,
 * tomorrow's tasks and up to five of tomorrow's meetings. It read no mail, and
 * in production nearly every send in a 30-day window was "0 tasks completed.
 * Tomorrow looks clear." A push that says nothing trains the user to ignore
 * the next one, so an empty evening now sends nothing.
 *
 * What counts as open (any one is enough):
 *  - mail received today that is PUSH-lane or needs a reply, and has not been
 *    answered, archived or dismissed (in Klorn or in the provider);
 *  - an open commitment the user owes that is due today or overdue
 *    (overdue is bounded to OVERDUE_LOOKBACK_DAYS so a stale one cannot ring
 *    every evening forever);
 *  - something the other side owes: an open counterparty commitment due
 *    today or overdue, or a thread brief's "they owe you" on a thread with a
 *    message today.
 * Tomorrow's first timed meeting rides along with any of those, and sends on
 * its own only when it starts before EARLY_MEETING_MINUTE local.
 *
 * Copy follows the user's notification language, like the briefing body.
 * Rule-based, no LLM.
 */

import { prisma } from "../db.js";
import { normalizeTier } from "../judge/tiers.js";
import { senderName } from "../notify/notification-format.js";
import type { NotificationLanguage } from "../notify/notification-strings.js";
import { readCalendarRows } from "../pim/calendar-read.js";
import { localDayUtcRange, localMinuteOfDay } from "../time-zone.js";
import { stripUntrusted } from "../untrusted.js";

/** Overdue commitments older than this stop ringing the evening review. */
const OVERDUE_LOOKBACK_DAYS = 7;
/** A meeting tomorrow before this local minute sends the review on its own. */
const EARLY_MEETING_MINUTE = 10 * 60;
/** Items named per section; the header carries the full count. */
const LIST_LIMIT = 3;
/** Today's mail rows read per user; far above a real day's needs-reply volume. */
const TODAY_MAIL_SCAN = 200;
const COMMITMENT_SCAN = 20;
const THREAD_BRIEF_SCAN = 10;
/** Tomorrow's rows read to find the first one with a duration. */
const TOMORROW_ROWS = 3;
const LINE_MAX = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const HALF_DAY_MS = 12 * 60 * 60 * 1000;

export interface EveningMail {
  readonly id: string;
  readonly from: string;
  readonly subject: string;
}

export interface EveningCommitment {
  readonly title: string;
  readonly overdue: boolean;
}

export interface EveningMeeting {
  readonly title: string;
  readonly startTime: Date;
}

export interface EveningReviewInput {
  readonly unanswered: readonly EveningMail[];
  readonly commitments: readonly EveningCommitment[];
  /** What the other side still owes the user, as display text. */
  readonly theyOwe: readonly string[];
  readonly firstMeetingTomorrow: EveningMeeting | null;
}

export interface EveningReviewMessage {
  readonly title: string;
  readonly message: string;
}

interface EveningCopy {
  title: (count: number) => string;
  earlyStartTitle: string;
  unanswered: (count: number) => string;
  commitments: (count: number) => string;
  theyOwe: (count: number) => string;
  overdue: string;
  firstMeeting: (time: string, title: string) => string;
  noSubject: string;
  timeLocale: string;
}

/** One column per shipped language: tsc names any entry a new language misses. */
const COPY: Record<NotificationLanguage, EveningCopy> = {
  en: {
    title: (n) => `${n} thing${n === 1 ? "" : "s"} still open today`,
    earlyStartTitle: "Early start tomorrow",
    unanswered: (n) => `Unanswered today (${n})`,
    commitments: (n) => `Due today or overdue (${n})`,
    theyOwe: (n) => `Waiting on others (${n})`,
    overdue: "overdue",
    firstMeeting: (time, title) => `Tomorrow starts at ${time}: ${title}`,
    noSubject: "(no subject)",
    timeLocale: "en-US",
  },
  ko: {
    title: (n) => `오늘 아직 남은 일 ${n}건`,
    earlyStartTitle: "내일 이른 일정",
    unanswered: (n) => `오늘 답장하지 않은 메일 (${n})`,
    commitments: (n) => `오늘 마감이거나 기한 지남 (${n})`,
    theyOwe: (n) => `상대 쪽 회신 대기 (${n})`,
    overdue: "기한 지남",
    firstMeeting: (time, title) => `내일 첫 일정 ${time}: ${title}`,
    noSubject: "(제목 없음)",
    timeLocale: "ko-KR",
  },
  ja: {
    title: (n) => `今日まだ残っていること ${n}件`,
    earlyStartTitle: "明日は早い予定があります",
    unanswered: (n) => `今日の未返信メール (${n})`,
    commitments: (n) => `今日が期限・期限切れ (${n})`,
    theyOwe: (n) => `相手の対応待ち (${n})`,
    overdue: "期限切れ",
    firstMeeting: (time, title) => `明日の最初の予定 ${time}: ${title}`,
    noSubject: "(件名なし)",
    timeLocale: "ja-JP",
  },
  zh: {
    title: (n) => `今天还有 ${n} 件事未完成`,
    earlyStartTitle: "明天有早间日程",
    unanswered: (n) => `今天未回复的邮件 (${n})`,
    commitments: (n) => `今天到期或已逾期 (${n})`,
    theyOwe: (n) => `等待对方 (${n})`,
    overdue: "已逾期",
    firstMeeting: (time, title) => `明天第一个日程 ${time}：${title}`,
    noSubject: "(无主题)",
    timeLocale: "zh-CN",
  },
  es: {
    title: (n) => (n === 1 ? "1 asunto pendiente hoy" : `${n} asuntos pendientes hoy`),
    earlyStartTitle: "Mañana empiezas temprano",
    unanswered: (n) => `Sin responder hoy (${n})`,
    commitments: (n) => `Vence hoy o vencido (${n})`,
    theyOwe: (n) => `Esperando a otros (${n})`,
    overdue: "vencido",
    firstMeeting: (time, title) => `Mañana empieza a las ${time}: ${title}`,
    noSubject: "(sin asunto)",
    timeLocale: "es-ES",
  },
  fr: {
    title: (n) =>
      n === 1 ? "1 point encore ouvert aujourd'hui" : `${n} points encore ouverts aujourd'hui`,
    earlyStartTitle: "Début matinal demain",
    unanswered: (n) => `Sans réponse aujourd'hui (${n})`,
    commitments: (n) => `Échéance aujourd'hui ou dépassée (${n})`,
    theyOwe: (n) => `En attente des autres (${n})`,
    overdue: "en retard",
    firstMeeting: (time, title) => `Demain, premier rendez-vous à ${time} : ${title}`,
    noSubject: "(sans objet)",
    timeLocale: "fr-FR",
  },
  de: {
    title: (n) => (n === 1 ? "1 offener Punkt heute" : `${n} offene Punkte heute`),
    earlyStartTitle: "Morgen früher Start",
    unanswered: (n) => `Heute unbeantwortet (${n})`,
    commitments: (n) => `Heute fällig oder überfällig (${n})`,
    theyOwe: (n) => `Warten auf andere (${n})`,
    overdue: "überfällig",
    firstMeeting: (time, title) => `Morgen erster Termin um ${time}: ${title}`,
    noSubject: "(kein Betreff)",
    timeLocale: "de-DE",
  },
};

function clip(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > LINE_MAX ? `${flat.slice(0, LINE_MAX - 1)}…` : flat;
}

function formatTime(date: Date, timeZone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone }).format(
    date,
  );
}

function section(header: string, items: readonly string[]): string[] {
  return [header, ...items.slice(0, LIST_LIMIT).map((item) => `• ${item}`)];
}

/**
 * The review to send, or null when there is nothing to close tonight. Pure:
 * the caller gathers the input and owns delivery and dedupe.
 */
export function composeEveningReview(
  input: EveningReviewInput,
  lang: NotificationLanguage,
  timeZone: string,
): EveningReviewMessage | null {
  const copy = COPY[lang] ?? COPY.en;
  const openCount = input.unanswered.length + input.commitments.length + input.theyOwe.length;
  const meeting = input.firstMeetingTomorrow;
  const earlyMeeting =
    meeting !== null && localMinuteOfDay(meeting.startTime, timeZone) < EARLY_MEETING_MINUTE;
  if (openCount === 0 && !earlyMeeting) return null;

  const lines: string[] = [];
  if (input.unanswered.length > 0) {
    const mails = input.unanswered.map(
      (m) => `${senderName(m.from, lang)} — ${clip(m.subject || copy.noSubject)}`,
    );
    lines.push(...section(copy.unanswered(input.unanswered.length), mails));
  }
  if (input.commitments.length > 0) {
    const items = input.commitments.map((c) =>
      c.overdue ? `${clip(c.title)} (${copy.overdue})` : clip(c.title),
    );
    lines.push(...section(copy.commitments(input.commitments.length), items));
  }
  if (input.theyOwe.length > 0) {
    lines.push(...section(copy.theyOwe(input.theyOwe.length), input.theyOwe.map(clip)));
  }
  if (meeting) {
    lines.push(
      copy.firstMeeting(
        formatTime(meeting.startTime, timeZone, copy.timeLocale),
        clip(meeting.title),
      ),
    );
  }

  return {
    title: openCount > 0 ? copy.title(openCount) : copy.earlyStartTitle,
    message: lines.join("\n"),
  };
}

interface DayRange {
  readonly gte: Date;
  readonly lt: Date;
}

/**
 * Today's mail that still wants the user: PUSH-lane or needs-reply, not
 * replied in Klorn (repliedAt), and not replied, archived or dismissed
 * according to the decision ledger (Klorn and provider stamps both count).
 * A mail whose attention item was resolved, dismissed or snoozed is settled.
 */
async function unansweredToday(userId: string, today: DayRange): Promise<EveningMail[]> {
  const mails = await prisma.emailMessage.findMany({
    where: { userId, receivedAt: { gte: today.gte, lt: today.lt }, repliedAt: null },
    select: { id: true, from: true, subject: true, needsReply: true },
    orderBy: { receivedAt: "desc" },
    take: TODAY_MAIL_SCAN,
  });
  if (mails.length === 0) return [];

  const ids = mails.map((m) => m.id);
  const [attention, engaged] = await Promise.all([
    prisma.attentionItem.findMany({
      where: { userId, source: "EMAIL", sourceId: { in: ids } },
      select: { sourceId: true, tier: true, status: true },
    }),
    prisma.decisionLabel.findMany({
      where: {
        userId,
        source: "EMAIL",
        sourceId: { in: ids },
        OR: [
          { repliedAt: { not: null } },
          { providerRepliedAt: { not: null } },
          { archivedAt: { not: null } },
          { providerArchivedAt: { not: null } },
          { dismissedAt: { not: null } },
        ],
      },
      select: { sourceId: true },
    }),
  ]);
  const attentionBySource = new Map(attention.map((a) => [a.sourceId, a]));
  const settled = new Set(engaged.map((e) => e.sourceId));

  return mails
    .filter((mail) => {
      if (settled.has(mail.id)) return false;
      const item = attentionBySource.get(mail.id);
      if (item && item.status !== "OPEN") return false;
      return mail.needsReply || (item !== undefined && normalizeTier(item.tier) === "PUSH");
    })
    .map(({ id, from, subject }) => ({ id, from, subject }));
}

async function openCommitments(
  userId: string,
  today: DayRange,
  now: Date,
): Promise<{ mine: EveningCommitment[]; theirs: string[]; theirThreads: Set<string> }> {
  const rows = await prisma.commitment.findMany({
    where: {
      userId,
      status: "OPEN",
      dueAt: { gte: new Date(today.gte.getTime() - OVERDUE_LOOKBACK_DAYS * DAY_MS), lt: today.lt },
    },
    select: { title: true, dueAt: true, owner: true, counterpartyName: true, threadId: true },
    orderBy: { dueAt: "asc" },
    take: COMMITMENT_SCAN,
  });
  const mine: EveningCommitment[] = [];
  const theirs: string[] = [];
  const theirThreads = new Set<string>();
  for (const row of rows) {
    const title = stripUntrusted(row.title);
    if (row.owner === "COUNTERPARTY") {
      theirs.push(row.counterpartyName ? `${row.counterpartyName}: ${title}` : title);
      if (row.threadId) theirThreads.add(row.threadId);
    } else {
      mine.push({ title, overdue: row.dueAt !== null && row.dueAt.getTime() < now.getTime() });
    }
  }
  return { mine, theirs, theirThreads };
}

/** "They owe you" from thread briefs on threads that had a message today. */
async function briefsTheyOwe(
  userId: string,
  today: DayRange,
  skipThreads: ReadonlySet<string>,
): Promise<string[]> {
  const briefs = await prisma.threadBrief.findMany({
    where: { userId, theyOwe: { not: null }, lastMessageAt: { gte: today.gte, lt: today.lt } },
    select: { threadId: true, theyOwe: true },
    orderBy: { lastMessageAt: "desc" },
    take: THREAD_BRIEF_SCAN,
  });
  return briefs
    .filter((b) => !skipThreads.has(b.threadId) && b.theyOwe?.trim())
    .map((b) => stripUntrusted(b.theyOwe));
}

/** Tomorrow's first timed meeting; all-day rows and zero-length "note" rows are not meetings. */
async function firstMeetingTomorrow(
  userId: string,
  tomorrowStart: Date,
  timeZone: string,
): Promise<EveningMeeting | null> {
  const tomorrowEnd = localDayUtcRange(
    new Date(tomorrowStart.getTime() + HALF_DAY_MS),
    timeZone,
  ).lt;
  const rows = await readCalendarRows({
    userId,
    when: { startTime: { gte: tomorrowStart, lt: tomorrowEnd }, allDay: false },
    limit: TOMORROW_ROWS,
  });
  const first = rows.find((row) => row.endTime.getTime() > row.startTime.getTime());
  return first ? { title: stripUntrusted(first.title), startTime: first.startTime } : null;
}

/** Everything the review can name, for the user's local day containing `now`. */
export async function gatherEveningReviewInput(
  userId: string,
  timeZone: string,
  now: Date,
): Promise<EveningReviewInput> {
  const today = localDayUtcRange(now, timeZone);
  const [unanswered, commitments, meeting] = await Promise.all([
    unansweredToday(userId, today),
    openCommitments(userId, today, now),
    firstMeetingTomorrow(userId, today.lt, timeZone),
  ]);
  const briefs = await briefsTheyOwe(userId, today, commitments.theirThreads);
  return {
    unanswered,
    commitments: commitments.mine,
    theyOwe: [...commitments.theirs, ...briefs],
    firstMeetingTomorrow: meeting,
  };
}
