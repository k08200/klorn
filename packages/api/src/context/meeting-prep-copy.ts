/**
 * Meeting prep as text, for server-rendered surfaces (the evening review):
 * a fixed template per notification language, filled only with the item's own
 * fields. Each line keeps the source it was rendered from, so a surface can
 * always link it back. Clients with their own UI render the structured block
 * (@klorn/contract MeetingPrep) in the app language instead.
 */

import type { MeetingPrep, MeetingPrepItem, MeetingPrepSource } from "@klorn/contract";
import type { NotificationLanguage } from "../notify/notification-strings.js";

export interface PrepLine {
  readonly text: string;
  readonly source: MeetingPrepSource;
}

interface PrepCopy {
  /** Review title when prep is all there is to say tonight. */
  title: string;
  header: (time: string, title: string) => string;
  promised: (title: string) => string;
  theyOwe: (who: string, title: string) => string;
  /** The other side, when the commitment names no one. */
  they: string;
  due: (date: string) => string;
  suggestion: (line: string) => string;
  unanswered: (from: string, subject: string) => string;
  recent: (from: string, subject: string) => string;
  noSubject: string;
  locale: string;
}

/** One column per shipped language: tsc names any entry a new language misses. */
const COPY: Record<NotificationLanguage, PrepCopy> = {
  en: {
    title: "Prep for tomorrow morning",
    header: (time, title) => `Before ${time} ${title}`,
    promised: (t) => `You promised: ${t}`,
    theyOwe: (who, t) => `${who} owe${who === "They" ? "" : "s"} you: ${t}`,
    they: "They",
    due: (d) => ` (by ${d})`,
    suggestion: (line) => `Suggestion: ${line}`,
    unanswered: (f, s) => `Unanswered: ${f} — ${s}`,
    recent: (f, s) => `Recent: ${f} — ${s}`,
    noSubject: "(no subject)",
    locale: "en-US",
  },
  ko: {
    title: "내일 오전 회의 준비",
    header: (time, title) => `${time} ${title} 전에`,
    promised: (t) => `내가 약속한 것: ${t}`,
    theyOwe: (who, t) => `${who} 쪽이 줄 것: ${t}`,
    they: "상대",
    due: (d) => ` (${d}까지)`,
    suggestion: (line) => `제안: ${line}`,
    unanswered: (f, s) => `미회신: ${f} — ${s}`,
    recent: (f, s) => `최근: ${f} — ${s}`,
    noSubject: "(제목 없음)",
    locale: "ko-KR",
  },
  ja: {
    title: "明朝の会議の準備",
    header: (time, title) => `${time} ${title} の前に`,
    promised: (t) => `約束したこと: ${t}`,
    theyOwe: (who, t) => `${who}からの約束: ${t}`,
    they: "相手",
    due: (d) => `（${d}まで）`,
    suggestion: (line) => `候補: ${line}`,
    unanswered: (f, s) => `未返信: ${f} — ${s}`,
    recent: (f, s) => `最近: ${f} — ${s}`,
    noSubject: "（件名なし）",
    locale: "ja-JP",
  },
  zh: {
    title: "明早会议准备",
    header: (time, title) => `${time} ${title} 之前`,
    promised: (t) => `你答应的: ${t}`,
    theyOwe: (who, t) => `${who}答应你的: ${t}`,
    they: "对方",
    due: (d) => `（${d}前）`,
    suggestion: (line) => `建议: ${line}`,
    unanswered: (f, s) => `未回复: ${f} — ${s}`,
    recent: (f, s) => `近期: ${f} — ${s}`,
    noSubject: "（无主题）",
    locale: "zh-CN",
  },
  es: {
    title: "Preparación para mañana por la mañana",
    header: (time, title) => `Antes de las ${time}: ${title}`,
    promised: (t) => `Prometiste: ${t}`,
    theyOwe: (who, t) => `${who} te debe: ${t}`,
    they: "La otra parte",
    due: (d) => ` (para el ${d})`,
    suggestion: (line) => `Sugerencia: ${line}`,
    unanswered: (f, s) => `Sin responder: ${f} — ${s}`,
    recent: (f, s) => `Reciente: ${f} — ${s}`,
    noSubject: "(sin asunto)",
    locale: "es-ES",
  },
  fr: {
    title: "À préparer pour demain matin",
    header: (time, title) => `Avant ${time} : ${title}`,
    promised: (t) => `Promis : ${t}`,
    theyOwe: (who, t) => `${who} vous doit : ${t}`,
    they: "L'autre partie",
    due: (d) => ` (pour le ${d})`,
    suggestion: (line) => `Suggestion : ${line}`,
    unanswered: (f, s) => `Sans réponse : ${f} — ${s}`,
    recent: (f, s) => `Récent : ${f} — ${s}`,
    noSubject: "(sans objet)",
    locale: "fr-FR",
  },
  de: {
    title: "Vorbereitung für morgen früh",
    header: (time, title) => `Vor ${time}: ${title}`,
    promised: (t) => `Zugesagt: ${t}`,
    theyOwe: (who, t) => `${who} schuldet Ihnen: ${t}`,
    they: "Die Gegenseite",
    due: (d) => ` (bis ${d})`,
    suggestion: (line) => `Vorschlag: ${line}`,
    unanswered: (f, s) => `Unbeantwortet: ${f} — ${s}`,
    recent: (f, s) => `Kürzlich: ${f} — ${s}`,
    noSubject: "(kein Betreff)",
    locale: "de-DE",
  },
};

export function prepCopy(lang: NotificationLanguage): PrepCopy {
  return COPY[lang] ?? COPY.en;
}

function formatDay(iso: string, timeZone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone,
  }).format(new Date(iso));
}

function formatTime(iso: string, timeZone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone }).format(
    new Date(iso),
  );
}

function lineFor(item: MeetingPrepItem, copy: PrepCopy, timeZone: string): string {
  if (item.kind === "commitment") {
    const due = item.dueAt ? copy.due(formatDay(item.dueAt, timeZone, copy.locale)) : "";
    const base =
      item.owner === "USER"
        ? copy.promised(item.title)
        : copy.theyOwe(item.counterpartyName || copy.they, item.title);
    return item.confirmed ? `${base}${due}` : copy.suggestion(`${base}${due}`);
  }
  const subject = item.subject || copy.noSubject;
  return item.kind === "unanswered"
    ? copy.unanswered(item.from, subject)
    : copy.recent(item.from, subject);
}

/** One line per item, in order, each with the item's source. */
export function renderPrepLines(
  items: readonly MeetingPrepItem[],
  lang: NotificationLanguage,
  timeZone: string,
): PrepLine[] {
  const copy = prepCopy(lang);
  return items.map((item) => ({ text: lineFor(item, copy, timeZone), source: item.source }));
}

/** "Before 10:00 AM Acme sync", in the user's zone and language. */
export function renderPrepHeader(
  meeting: MeetingPrep,
  lang: NotificationLanguage,
  timeZone: string,
): string {
  const copy = prepCopy(lang);
  return copy.header(formatTime(meeting.startTime, timeZone, copy.locale), meeting.title);
}
