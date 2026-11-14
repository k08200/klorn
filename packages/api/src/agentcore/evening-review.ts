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
 *  - mail received today that needs a reply, or PUSH-lane mail not yet read,
 *    in a thread the user has not answered since (in Klorn, in the provider,
 *    or by a Sent-folder row), and not archived or dismissed;
 *  - an open commitment the user owes (owner USER, confirmed: extraction confidence at
 *    least MIN_COMMITMENT_CONFIDENCE or confirmed by the user in the ledger)
 *    that is due today or overdue; overdue
 *    is bounded to OVERDUE_LOOKBACK_DAYS, since nothing closes a commitment
 *    when the user keeps it;
 *  - something the other side owes: an open counterparty commitment due
 *    today or overdue, or a thread brief's "they owe you" on a thread with a
 *    message today.
 * Tomorrow's first timed meeting rides along with any of those, and sends on
 * its own only when it starts before EARLY_MEETING_MINUTE local.
 *
 * Meeting prep (CONTEXT_MEETING_PREP_ENABLED, context/meeting-prep.ts): a
 * meeting tomorrow before MORNING_END_MINUTE local with something to prep
 * (an open commitment, unanswered mail or a recent thread with its external
 * attendees) is listed with those items, and is reason enough to send.
 *
 * Copy follows the user's notification language, like the briefing body.
 * Rule-based, no LLM.
 */

import type { MeetingPrep } from "@klorn/contract";
import { prepCopy, renderPrepHeader, renderPrepLines } from "../context/meeting-prep-copy.js";
import { isActionablePrepItem } from "../context/meeting-prep-link.js";
import { meetingPrepForUser } from "../context/meeting-prep-surface.js";
import { prisma } from "../db.js";
import { normalizeTier } from "../judge/tiers.js";
import { lastReplyByThread } from "../mail/thread-last-reply.js";
import { senderName } from "../notify/notification-format.js";
import type { NotificationLanguage } from "../notify/notification-strings.js";
import { readCalendarRows } from "../pim/calendar-read.js";
import { COMMITMENT_CONFIRMED_MIN_CONFIDENCE } from "../pim/commitment-confirmation.js";
import { localDayUtcRange, localMinuteOfDay } from "../time-zone.js";
import { stripUntrusted } from "../untrusted.js";

/**
 * Overdue commitments older than this stop ringing the evening review. Short:
 * nothing closes a commitment when the user keeps it, so a kept promise would
 * otherwise ring every evening of the window.
 */
const OVERDUE_LOOKBACK_DAYS = 2;
/** Extraction confidence a commitment needs before it can ring the review (unless confirmed). */
const MIN_COMMITMENT_CONFIDENCE = COMMITMENT_CONFIRMED_MIN_CONFIDENCE;
/** A timed block longer than this (out of office, travel) is not a meeting. */
const MAX_MEETING_MS = 8 * 60 * 60 * 1000;
/** A meeting tomorrow before this local minute sends the review on its own. */
const EARLY_MEETING_MINUTE = 10 * 60;
/** Meetings tomorrow starting before this local minute get their prep in the review. */
const MORNING_END_MINUTE = 12 * 60;
/** Prepped meetings listed in one review. */
const PREP_MEETINGS_LIMIT = 2;
/** Items named per section; the header carries the full count. */
const LIST_LIMIT = 3;
/** Today's mail rows read per user; far above a real day's needs-reply volume. */
const TODAY_MAIL_SCAN = 200;
const COMMITMENT_SCAN = 20;
const THREAD_BRIEF_SCAN = 10;
/** Tomorrow's rows read to find the first one with a duration. */
const TOMORROW_ROWS = 3;
const LINE_MAX = 60;
/** Bidirectional controls: they can reorder what a push appears to say. */
const BIDI_CONTROLS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
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
  /** Tomorrow-morning meetings with prep (flag on); absent or empty otherwise. */
  readonly meetingPrep?: readonly MeetingPrep[];
}

export interface EveningReviewMessage {
  readonly title: string;
  /** The bell row: every section, up to LIST_LIMIT items each. */
  readonly message: string;
  /** The device push: short enough that nothing is cut at its 200 characters. */
  readonly pushBody: string;
}

interface EveningCopy {
  title: (count: number) => string;
  earlyStartTitle: string;
  openMail: (count: number) => string;
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
    openMail: (n) => `Today's mail still open (${n})`,
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
    openMail: (n) => `오늘 메일 중 아직 열린 것 (${n})`,
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
    openMail: (n) => `今日のメールで未対応 (${n})`,
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
    openMail: (n) => `今天仍待处理的邮件 (${n})`,
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
    openMail: (n) => `Correo de hoy aún pendiente (${n})`,
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
    openMail: (n) => `Mails du jour encore en attente (${n})`,
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
    openMail: (n) => `Heutige Mails noch offen (${n})`,
    commitments: (n) => `Heute fällig oder überfällig (${n})`,
    theyOwe: (n) => `Warten auf andere (${n})`,
    overdue: "überfällig",
    firstMeeting: (time, title) => `Morgen erster Termin um ${time}: ${title}`,
    noSubject: "(kein Betreff)",
    timeLocale: "de-DE",
  },
};

function clip(value: string): string {
  const flat = value.replace(BIDI_CONTROLS, "").replace(/\s+/g, " ").trim();
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

/** Tomorrow-morning meetings with prep, at most PREP_MEETINGS_LIMIT. */
const preppedMeetings = (input: EveningReviewInput): MeetingPrep[] =>
  (input.meetingPrep ?? []).filter((p) => p.items.length > 0).slice(0, PREP_MEETINGS_LIMIT);

/**
 * Whether the review has anything to say: an open item, tomorrow's first
 * meeting starting before EARLY_MEETING_MINUTE local, or prep that asks
 * something of the user (a confirmed commitment or mail awaiting a reply). A
 * recent thread or an unconfirmed suggestion rides along but never rings.
 */
export function eveningReviewHasContent(input: EveningReviewInput, timeZone: string): boolean {
  if (input.unanswered.length + input.commitments.length + input.theyOwe.length > 0) return true;
  if (preppedMeetings(input).some((p) => p.items.some(isActionablePrepItem))) return true;
  const meeting = input.firstMeetingTomorrow;
  return meeting !== null && localMinuteOfDay(meeting.startTime, timeZone) < EARLY_MEETING_MINUTE;
}

interface ReviewSection {
  readonly header: string;
  readonly items: string[];
}

/** The open sections: today's mail, the user's commitments, what others owe. */
function openSections(
  input: EveningReviewInput,
  copy: EveningCopy,
  lang: NotificationLanguage,
): ReviewSection[] {
  const sections: ReviewSection[] = [];
  if (input.unanswered.length > 0) {
    sections.push({
      header: copy.openMail(input.unanswered.length),
      items: input.unanswered.map(
        (m) => `${clip(senderName(m.from, lang))} — ${clip(m.subject || copy.noSubject)}`,
      ),
    });
  }
  if (input.commitments.length > 0) {
    sections.push({
      header: copy.commitments(input.commitments.length),
      items: input.commitments.map((c) =>
        c.overdue ? `${clip(c.title)} (${copy.overdue})` : clip(c.title),
      ),
    });
  }
  if (input.theyOwe.length > 0) {
    sections.push({ header: copy.theyOwe(input.theyOwe.length), items: input.theyOwe.map(clip) });
  }
  return sections;
}

/** Tomorrow's first meeting as a line, unless a prep header already names it. */
function firstMeetingLine(
  input: EveningReviewInput,
  prepped: readonly MeetingPrep[],
  copy: EveningCopy,
  timeZone: string,
): string | null {
  const meeting = input.firstMeetingTomorrow;
  if (!meeting) return null;
  if (prepped.some((p) => Date.parse(p.startTime) === meeting.startTime.getTime())) return null;
  return copy.firstMeeting(
    formatTime(meeting.startTime, timeZone, copy.timeLocale),
    clip(meeting.title),
  );
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
  if (!eveningReviewHasContent(input, timeZone)) return null;
  const copy = COPY[lang] ?? COPY.en;
  const sections = openSections(input, copy, lang);
  const prepped = preppedMeetings(input);
  const prepSections: ReviewSection[] = prepped.map((p) => ({
    header: clip(renderPrepHeader(p, lang, timeZone)),
    items: renderPrepLines(p.items, lang, timeZone).map((line) => clip(line.text)),
  }));
  const meetingLine = firstMeetingLine(input, prepped, copy, timeZone);

  const openCount = sections.reduce((sum, s) => sum + s.items.length, 0);
  const lines = [...sections, ...prepSections].flatMap((s) => section(s.header, s.items));
  // One open item: name it. More: the section counts, which always fit.
  const summary =
    openCount === 1 ? (sections[0]?.items[0] ?? "") : sections.map((s) => s.header).join(" · ");
  // The push names the first prepped meeting instead of the first meeting: one
  // clipped line either way, so the body stays inside its 200 characters.
  const pushParts = [summary, prepSections[0]?.header ?? meetingLine].filter(
    (part): part is string => Boolean(part),
  );
  const fallbackTitle = prepped.length > 0 ? prepCopy(lang).title : copy.earlyStartTitle;
  return {
    title: openCount > 0 ? copy.title(openCount) : fallbackTitle,
    message: [...lines, ...(meetingLine ? [meetingLine] : [])].join("\n"),
    pushBody: pushParts.join("\n"),
  };
}

interface DayRange {
  readonly gte: Date;
  readonly lt: Date;
}

interface TodayMail {
  readonly id: string;
  readonly from: string;
  readonly subject: string;
  readonly needsReply: boolean;
  readonly isRead: boolean;
  readonly threadId: string | null;
  readonly receivedAt: Date;
}

/**
 * Today's mail that still wants the user, one per thread (the newest): mail
 * that needs a reply, or PUSH-lane mail not yet read. A thread the user
 * answered after that mail arrived is done — a reply through Klorn, one the
 * provider scan saw, or a Sent-folder row in the thread — as is a mail that
 * was archived or dismissed, or whose attention item is no longer open.
 */
async function unansweredToday(userId: string, today: DayRange): Promise<EveningMail[]> {
  const rows = await prisma.emailMessage.findMany({
    where: { userId, receivedAt: { gte: today.gte, lt: today.lt } },
    select: {
      id: true,
      from: true,
      subject: true,
      needsReply: true,
      isRead: true,
      threadId: true,
      receivedAt: true,
      repliedAt: true,
    },
    orderBy: { receivedAt: "desc" },
    take: TODAY_MAIL_SCAN,
  });
  if (rows.length === 0) return [];

  const ids = rows.map((m) => m.id);
  const [attention, labels] = await Promise.all([
    prisma.attentionItem.findMany({
      where: { userId, source: "EMAIL", sourceId: { in: ids } },
      select: { sourceId: true, tier: true, status: true },
    }),
    prisma.decisionLabel.findMany({
      where: { userId, source: "EMAIL", sourceId: { in: ids } },
      select: {
        sourceId: true,
        repliedAt: true,
        providerRepliedAt: true,
        archivedAt: true,
        providerArchivedAt: true,
        dismissedAt: true,
      },
    }),
  ]);
  const attentionBySource = new Map(attention.map((a) => [a.sourceId, a]));
  const ledger = new Map(labels.map((l) => [l.sourceId, l]));
  const lastReply = await lastReplyByThread(
    userId,
    rows,
    ledger,
    new Map(rows.map((r) => [r.id, r.repliedAt])),
    today.gte,
  );

  const seenThreads = new Set<string>();
  const open: EveningMail[] = [];
  for (const mail of rows) {
    const thread = mail.threadId ?? mail.id;
    if (seenThreads.has(thread)) continue;
    const label = ledger.get(mail.id);
    if (label?.archivedAt || label?.providerArchivedAt || label?.dismissedAt) continue;
    const item = attentionBySource.get(mail.id);
    if (item && item.status !== "OPEN") continue;
    const unreadPush = !mail.isRead && item !== undefined && normalizeTier(item.tier) === "PUSH";
    if (!mail.needsReply && !unreadPush) continue;
    if ((lastReply.get(thread) ?? 0) >= mail.receivedAt.getTime()) continue;
    seenThreads.add(thread);
    open.push({ id: mail.id, from: mail.from, subject: mail.subject });
  }
  return open;
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
      owner: { in: ["USER", "COUNTERPARTY"] },
      // Confirmed only (pim/commitment-confirmation.ts): a rule-mined
      // suggestion rings nothing until the user confirms it in the ledger.
      OR: [{ confidence: { gte: MIN_COMMITMENT_CONFIDENCE } }, { confirmedAt: { not: null } }],
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

/**
 * Tomorrow's first timed meeting. All-day rows, zero-length "note" rows and
 * blocks longer than MAX_MEETING_MS (out of office) are not meetings.
 */
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
  const first = rows.find((row) => {
    const span = row.endTime.getTime() - row.startTime.getTime();
    return span > 0 && span <= MAX_MEETING_MS;
  });
  return first ? { title: stripUntrusted(first.title), startTime: first.startTime } : null;
}

/**
 * Tomorrow-morning meetings with prep (flag on): the next-24-hour block,
 * narrowed to meetings starting tomorrow before MORNING_END_MINUTE local.
 * Never throws (meetingPrepForUser is fail-open).
 */
async function tomorrowMorningPrep(
  userId: string,
  tomorrowStart: Date,
  timeZone: string,
  now: Date,
): Promise<MeetingPrep[]> {
  const block = await meetingPrepForUser(userId, now);
  if (!block) return [];
  const tomorrowEnd = localDayUtcRange(
    new Date(tomorrowStart.getTime() + HALF_DAY_MS),
    timeZone,
  ).lt;
  return block.meetings.filter((p) => {
    const start = new Date(p.startTime);
    return (
      start.getTime() >= tomorrowStart.getTime() &&
      start.getTime() < tomorrowEnd.getTime() &&
      localMinuteOfDay(start, timeZone) < MORNING_END_MINUTE
    );
  });
}

/** Everything the review can name, for the user's local day containing `now`. */
export async function gatherEveningReviewInput(
  userId: string,
  timeZone: string,
  now: Date,
): Promise<EveningReviewInput> {
  const today = localDayUtcRange(now, timeZone);
  const [unanswered, commitments, meeting, meetingPrep] = await Promise.all([
    unansweredToday(userId, today),
    openCommitments(userId, today, now),
    firstMeetingTomorrow(userId, today.lt, timeZone),
    tomorrowMorningPrep(userId, today.lt, timeZone, now),
  ]);
  const briefs = await briefsTheyOwe(userId, today, commitments.theirThreads);
  return {
    unanswered,
    commitments: commitments.mine,
    theyOwe: [...commitments.theirs, ...briefs],
    firstMeetingTomorrow: meeting,
    meetingPrep,
  };
}
