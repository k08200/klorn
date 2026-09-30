/**
 * Briefing v2 structure (2026-08-22): the glanceable layer above the prose —
 * a one-sentence day verdict, at most three time segments with a kind and a
 * measured summary, an hourly intensity curve for the client sparkline, and
 * the ranked attention list. Everything here is DETERMINISTIC and localized
 * server-side (notificationLanguage), so both clients render the same truth
 * with zero client-side translation. The LLM prose body is unchanged and
 * rides below this structure.
 */

import { prisma } from "../db.js";
import {
  type NotificationLanguage,
  resolveNotificationLanguage,
} from "../notify/notification-strings.js";
import { localDayUtcRange } from "../time-zone.js";
import { stripUntrusted } from "../untrusted.js";
import { getUserTimeZone } from "../user-timezone.js";
import { dedupeCalendarEvents } from "./calendar-dedupe.js";
import { calendarSourceScope } from "./calendar-scope.js";
import {
  buildDayShape,
  DAY_END_HOUR,
  DAY_START_HOUR,
  type DaySegment,
  localHour,
} from "./day-shape.js";

export interface BriefingSegmentView {
  label: string;
  summary: string;
  kind: "busy" | "free" | "off";
}

export interface BriefingStructure {
  /** Localized long date, e.g. "2026년 8월 22일 토요일". */
  dateLabel: string;
  /** One-sentence day verdict, e.g. "열 시 전에 회의 세 건. 나머지는 비어 있습니다." */
  headline: string;
  segments: BriefingSegmentView[];
  /** Overlap count per hour, index 0 = 08:00 local. */
  curve: number[];
  dayStartHour: number;
  attention: Array<{ rank: number; action: string; reason: string }>;
}

type Lang = NotificationLanguage;

/**
 * Every sentence this module can produce, in one table.
 *
 * It used to be ~13 inline `lang === "ko" ? … : …` ternaries scattered through
 * the formatters. That shape does not scale past two languages: a third means
 * touching every branch, and nothing tells you which sentence you forgot.
 * As a table typed by NotificationLanguage, adding a language is one column
 * and tsc names every entry still missing it.
 *
 * Functions, not plain strings, because these sentences interpolate measured
 * numbers — and the grammar around a count differs per language.
 */
const COPY: Record<Lang, BriefingCopy> = {
  en: {
    today: "Today",
    beforeHour: (h) => `Before ${h}`,
    afterHour: (h) => `After ${h}`,
    hourRange: (from, to) => `${from} – ${to}`,
    offSummary: "Nothing scheduled. It's a day off.",
    freeSummary: (hours) => `${hours} hours open.`,
    busySummary: (count, list) => `${count} scheduled: ${list}`,
    offHeadline: "Nothing on the calendar. It's a day off.",
    clearHeadline: "A clear day. Long focus blocks are yours.",
    frontLoaded: (n, boundary) =>
      `${n} meeting${n === 1 ? "" : "s"} before ${boundary}. The rest is open.`,
    withOpenHours: (n, free) => `${n} meeting${n === 1 ? "" : "s"} today, with ${free} open hours.`,
    backToBack: (n) => `${n} meeting${n === 1 ? "" : "s"} back to back today.`,
    hourLabel: (hour) => {
      const meridiem = hour < 12 ? "AM" : "PM";
      const h = hour === 12 ? 12 : hour % 12;
      return `${h} ${meridiem}`;
    },
    dateLocale: "en-US",
  },
  ko: {
    today: "오늘",
    beforeHour: (h) => `${h} 이전`,
    afterHour: (h) => `${h} 이후`,
    hourRange: (from, to) => `${from} – ${to}`,
    offSummary: "일정이 없습니다. 쉬는 날입니다.",
    freeSummary: (hours) => `${hours}시간 비어 있습니다.`,
    busySummary: (count, list) => `${count}건: ${list}`,
    offHeadline: "일정이 없습니다. 휴일입니다.",
    clearHeadline: "일정 없는 하루입니다. 긴 집중 블록을 쓸 수 있습니다.",
    frontLoaded: (n, boundary) => `${boundary} 전에 회의 ${n}건. 나머지는 비어 있습니다.`,
    withOpenHours: (n, free) => `오늘 회의 ${n}건, 비는 시간은 ${free}시간입니다.`,
    backToBack: (n) => `오늘 회의 ${n}건이 이어집니다.`,
    hourLabel: (hour) => {
      const meridiem = hour < 12 ? "오전" : "오후";
      const h = hour <= 12 ? hour : hour - 12;
      return `${meridiem} ${h}시`;
    },
    dateLocale: "ko-KR",
  },
  ja: {
    today: "今日",
    beforeHour: (h) => `${h}より前`,
    afterHour: (h) => `${h}以降`,
    hourRange: (from, to) => `${from} – ${to}`,
    offSummary: "予定はありません。休みの日です。",
    freeSummary: (hours) => `${hours}時間空いています。`,
    busySummary: (count, list) => `${count}件: ${list}`,
    offHeadline: "カレンダーは空です。休みの日です。",
    clearHeadline: "予定のない一日です。長い集中時間が取れます。",
    frontLoaded: (n, boundary) => `${boundary}までに会議${n}件。あとは空いています。`,
    withOpenHours: (n, free) => `今日は会議${n}件、空き時間は${free}時間です。`,
    backToBack: (n) => `今日は会議${n}件が続きます。`,
    hourLabel: (hour) => {
      const meridiem = hour < 12 ? "午前" : "午後";
      const h = hour <= 12 ? hour : hour - 12;
      return `${meridiem}${h}時`;
    },
    dateLocale: "ja-JP",
  },
  zh: {
    today: "今天",
    beforeHour: (h) => `${h}之前`,
    afterHour: (h) => `${h}之后`,
    hourRange: (from, to) => `${from} – ${to}`,
    offSummary: "没有日程。今天休息。",
    freeSummary: (hours) => `空出 ${hours} 小时。`,
    busySummary: (count, list) => `${count} 项：${list}`,
    offHeadline: "日历是空的。今天休息。",
    clearHeadline: "今天没有日程，可以安排长时间专注。",
    frontLoaded: (n, boundary) => `${boundary}前有 ${n} 场会议，其余时间空闲。`,
    withOpenHours: (n, free) => `今天有 ${n} 场会议，空闲 ${free} 小时。`,
    backToBack: (n) => `今天有 ${n} 场会议接连进行。`,
    hourLabel: (hour) => {
      const meridiem = hour < 12 ? "上午" : "下午";
      const h = hour <= 12 ? hour : hour - 12;
      return `${meridiem}${h}点`;
    },
    dateLocale: "zh-CN",
  },
  es: {
    today: "Hoy",
    beforeHour: (h) => `Antes de las ${h}`,
    afterHour: (h) => `Después de las ${h}`,
    hourRange: (from, to) => `${from} – ${to}`,
    offSummary: "Nada agendado. Es un día libre.",
    freeSummary: (hours) => `${hours} horas libres.`,
    busySummary: (count, list) => `${count} agendados: ${list}`,
    offHeadline: "Nada en el calendario. Es un día libre.",
    clearHeadline: "Un día despejado. Los bloques largos de foco son tuyos.",
    frontLoaded: (n, boundary) =>
      `${n} reunión${n === 1 ? "" : "es"} antes de las ${boundary}. El resto está libre.`,
    withOpenHours: (n, free) => `${n} reunión${n === 1 ? "" : "es"} hoy, con ${free} horas libres.`,
    backToBack: (n) => `${n} reunión${n === 1 ? "" : "es"} seguidas hoy.`,
    hourLabel: (hour) => `${hour}:00`,
    dateLocale: "es-ES",
  },
  fr: {
    today: "Aujourd'hui",
    beforeHour: (h) => `Avant ${h}`,
    afterHour: (h) => `Après ${h}`,
    hourRange: (from, to) => `${from} – ${to}`,
    offSummary: "Rien de prévu. C'est un jour de repos.",
    freeSummary: (hours) => `${hours} heures de libre.`,
    busySummary: (count, list) => `${count} prévus : ${list}`,
    offHeadline: "Rien au calendrier. C'est un jour de repos.",
    clearHeadline: "Une journée dégagée. Les longues plages de concentration sont à vous.",
    frontLoaded: (n, boundary) =>
      `${n} réunion${n === 1 ? "" : "s"} avant ${boundary}. Le reste est libre.`,
    withOpenHours: (n, free) =>
      `${n} réunion${n === 1 ? "" : "s"} aujourd'hui, avec ${free} heures de libre.`,
    backToBack: (n) => `${n} réunion${n === 1 ? "" : "s"} à la suite aujourd'hui.`,
    hourLabel: (hour) => `${hour} h`,
    dateLocale: "fr-FR",
  },
  de: {
    today: "Heute",
    beforeHour: (h) => `Vor ${h}`,
    afterHour: (h) => `Nach ${h}`,
    hourRange: (from, to) => `${from} – ${to}`,
    offSummary: "Nichts geplant. Ein freier Tag.",
    freeSummary: (hours) => `${hours} Stunden frei.`,
    busySummary: (count, list) => `${count} geplant: ${list}`,
    offHeadline: "Nichts im Kalender. Ein freier Tag.",
    clearHeadline: "Ein freier Tag. Lange Fokusblöcke gehören dir.",
    frontLoaded: (n, boundary) =>
      `${n} Meeting${n === 1 ? "" : "s"} vor ${boundary}. Der Rest ist frei.`,
    withOpenHours: (n, free) =>
      `${n} Meeting${n === 1 ? "" : "s"} heute, mit ${free} freien Stunden.`,
    backToBack: (n) => `${n} Meeting${n === 1 ? "" : "s"} hintereinander heute.`,
    hourLabel: (hour) => `${hour}:00 Uhr`,
    dateLocale: "de-DE",
  },
};

interface BriefingCopy {
  today: string;
  beforeHour: (hourLabel: string) => string;
  afterHour: (hourLabel: string) => string;
  hourRange: (from: string, to: string) => string;
  offSummary: string;
  freeSummary: (hours: number) => string;
  busySummary: (count: number, list: string) => string;
  offHeadline: string;
  clearHeadline: string;
  frontLoaded: (count: number, boundary: string) => string;
  withOpenHours: (count: number, freeHours: number) => string;
  backToBack: (count: number) => string;
  hourLabel: (hour: number) => string;
  /** BCP-47 tag for Intl date formatting. */
  dateLocale: string;
}

/** "10 AM" / "오전 10시" — segment labels use whole hours only. */
function hourLabel(hour: number, lang: Lang): string {
  return COPY[lang].hourLabel(hour);
}

function segmentLabel(seg: DaySegment, index: number, count: number, lang: Lang): string {
  const copy = COPY[lang];
  if (count === 1) return copy.today;
  if (index === 0) return copy.beforeHour(hourLabel(seg.endHour, lang));
  if (index === count - 1) return copy.afterHour(hourLabel(seg.startHour, lang));
  return copy.hourRange(hourLabel(seg.startHour, lang), hourLabel(seg.endHour, lang));
}

/** Measured, template-only summaries — no LLM, no invented numbers. */
function segmentSummary(seg: DaySegment, lang: Lang): string {
  const copy = COPY[lang];
  if (seg.kind === "off") return copy.offSummary;
  if (seg.kind === "free") return copy.freeSummary(seg.endHour - seg.startHour);
  const titles = seg.eventTitles.slice(0, 3).join(", ");
  const extra = seg.eventTitles.length - 3;
  const list = extra > 0 ? `${titles} +${extra}` : titles;
  return copy.busySummary(seg.eventTitles.length, list);
}

function headline(segments: DaySegment[], meetingCount: number, lang: Lang): string {
  const copy = COPY[lang];
  const only = segments.length === 1 ? segments[0] : null;
  if (only?.kind === "off") return copy.offHeadline;
  if (only?.kind === "free" || meetingCount === 0) return copy.clearHeadline;

  const firstBusy = segments.find((s) => s.kind === "busy");
  const lastFree = [...segments].reverse().find((s) => s.kind === "free");
  if (firstBusy && segments[0] === firstBusy && lastFree === segments[segments.length - 1]) {
    // The screenshot shape: front-loaded, then open.
    return copy.frontLoaded(meetingCount, hourLabel(firstBusy.endHour, lang));
  }
  if (lastFree) {
    return copy.withOpenHours(meetingCount, lastFree.endHour - lastFree.startHour);
  }
  return copy.backToBack(meetingCount);
}

function dateLabel(now: Date, timeZone: string, lang: Lang): string {
  return new Intl.DateTimeFormat(COPY[lang].dateLocale, {
    timeZone,
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(now);
}

/** Sat/Sun in the user's timezone. */
function isWeekend(now: Date, timeZone: string): boolean {
  const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(now);
  return day === "Sat" || day === "Sun";
}

/**
 * Compute the structure for the user's current local day. Deterministic from
 * calendar + signals at read time — nothing to store or invalidate.
 */
export async function buildBriefingStructure(
  userId: string,
  now: Date = new Date(),
): Promise<BriefingStructure> {
  const [timeZone, config] = await Promise.all([
    getUserTimeZone(userId),
    prisma.automationConfig.findUnique({
      where: { userId },
      select: { notificationLanguage: true },
    }),
  ]);
  const lang = resolveNotificationLanguage(config?.notificationLanguage);

  const { gte, lt } = localDayUtcRange(now, timeZone);
  // OVERLAP with today (not started-today): an event that began yesterday
  // and runs into this morning still occupies today's narrated window.
  const [rawRows, pushItems] = await Promise.all([
    prisma.calendarEvent.findMany({
      where: {
        userId,
        allDay: false,
        startTime: { lt },
        endTime: { gt: gte },
        ...calendarSourceScope(),
      },
      orderBy: { startTime: "asc" },
      take: 50,
      // The identity fields let an invite present in the primary and a linked
      // calendar (two rows, C2) count as one meeting.
      select: {
        title: true,
        startTime: true,
        endTime: true,
        provider: true,
        externalId: true,
        sourceAccountId: true,
      },
    }),
    // "Needs attention" = the open PUSH lane, cheapest honest source (pure
    // DB — this endpoint is polled, so it must never touch the Gmail API).
    prisma.attentionItem.findMany({
      where: { userId, status: "OPEN", tier: "PUSH" },
      orderBy: { priority: "desc" },
      take: 3,
      select: { title: true, tierReason: true },
    }),
  ]);
  const rows = dedupeCalendarEvents(rawRows);
  const events = rows.map((row) => ({
    title: row.title,
    // Clamp instants outside today's local day to the day edges — localHour
    // alone is date-blind and would wrap (23:00 yesterday → "23h today").
    startHour: row.startTime <= gte ? 0 : localHour(row.startTime, timeZone),
    endHour: row.endTime >= lt ? 24 : localHour(row.endTime, timeZone),
  }));

  const shape = buildDayShape(events, isWeekend(now, timeZone) && events.length === 0);
  const count = shape.segments.length;
  return {
    dateLabel: dateLabel(now, timeZone, lang),
    headline: headline(shape.segments, shape.meetingCount, lang),
    segments: shape.segments.map((seg, i) => ({
      label: segmentLabel(seg, i, count, lang),
      summary: segmentSummary(seg, lang),
      kind: seg.kind,
    })),
    curve: shape.curve,
    dayStartHour: DAY_START_HOUR,
    attention: pushItems.map((item, i) => ({
      rank: i + 1,
      action: stripUntrusted(item.title),
      reason: stripUntrusted(item.tierReason ?? ""),
    })),
  };
}

export const BRIEFING_DAY_END_HOUR = DAY_END_HOUR;
