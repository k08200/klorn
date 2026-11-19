/**
 * Copy of the NT0 notification kinds that had kept their old text — meet,
 * brief, agent, acct (canonical copy: decide-board gen_nt.py, decided
 * 2026-11-17). Klorn's own voice, so it follows the user's notification
 * language. Used only while NOTIFY_PUSH_PRESENTATION is open to the user
 * (notify/kind-push-copy.ts).
 *
 * Product languages are en / ko / zh (shipped-languages.ts). Anything else
 * reads English: a missing translation must never cost a notification.
 */

import { type ShippedLanguage, toShippedLanguage } from "../shipped-languages.js";

const MINUTES_PER_HOUR = 60;

export interface BriefCounts {
  /** Today's PUSH mail threads (the Today window). */
  urgentMail: number;
  /** Today's timed meetings (the briefing's day shape). */
  meetings: number;
  /** Free hours in the briefing's day window. */
  freeHours: number;
}

export interface KindPushCopy {
  /** A meeting with no usable title. */
  meetingFallbackTitle: string;
  /** How soon a meeting starts, in whole minutes (0 = now). */
  startsIn: (minutes: number) => string;
  /** How many people the invite lists. */
  attendees: (count: number) => string;
  briefTitle: string;
  briefLine: (counts: BriefCounts) => string;
  /** A reply draft to this person is ready. */
  draftReadyTitle: (person: string) => string;
  /** The body when the draft itself may not be shown. */
  draftReadyLine: string;
  /** This account (an address, else the provider) needs reconnecting. */
  disconnectedTitle: (account: string) => string;
  reconnectLine: string;
}

/** Whole hours and the minutes left over, for a start an hour or more away. */
function hoursAndMinutes(minutes: number): [number, number] {
  return [Math.floor(minutes / MINUTES_PER_HOUR), minutes % MINUTES_PER_HOUR];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const EN: KindPushCopy = {
  meetingFallbackTitle: "Meeting",
  startsIn: (m) => {
    if (m <= 0) return "Starting now";
    if (m < MINUTES_PER_HOUR) return `In ${m} min`;
    const [h, rest] = hoursAndMinutes(m);
    return rest === 0 ? `In ${h} hr` : `In ${h} hr ${rest} min`;
  },
  attendees: (n) => plural(n, "person", "people"),
  briefTitle: "Today's briefing",
  briefLine: ({ urgentMail, meetings, freeHours }) =>
    `${plural(urgentMail, "urgent email", "urgent emails")} · ${plural(meetings, "meeting", "meetings")} · ${plural(freeHours, "hour", "hours")} free`,
  draftReadyTitle: (person) => `Reply draft ready · ${person}`,
  draftReadyLine: "Review it before it is sent",
  disconnectedTitle: (account) => `${account} disconnected`,
  reconnectLine: "Reconnect it to sort this account's mail again",
};

const KO: KindPushCopy = {
  meetingFallbackTitle: "회의",
  startsIn: (m) => {
    if (m <= 0) return "지금 시작";
    if (m < MINUTES_PER_HOUR) return `${m}분 후`;
    const [h, rest] = hoursAndMinutes(m);
    return rest === 0 ? `${h}시간 후` : `${h}시간 ${rest}분 후`;
  },
  attendees: (n) => `${n}명`,
  briefTitle: "오늘 브리핑",
  briefLine: ({ urgentMail, meetings, freeHours }) =>
    `급한 메일 ${urgentMail} · 회의 ${meetings} · 빈 시간 ${freeHours}시간`,
  draftReadyTitle: (person) => `답장 초안 준비됨 · ${person}`,
  draftReadyLine: "확인 후 보낼 수 있습니다",
  disconnectedTitle: (account) => `${account} 연결 끊김`,
  reconnectLine: "다시 연결하면 이 계정 메일도 분류합니다",
};

const ZH: KindPushCopy = {
  meetingFallbackTitle: "会议",
  startsIn: (m) => {
    if (m <= 0) return "即将开始";
    if (m < MINUTES_PER_HOUR) return `${m}分钟后`;
    const [h, rest] = hoursAndMinutes(m);
    return rest === 0 ? `${h}小时后` : `${h}小时${rest}分钟后`;
  },
  attendees: (n) => `${n}人`,
  briefTitle: "今日简报",
  briefLine: ({ urgentMail, meetings, freeHours }) =>
    `紧急邮件 ${urgentMail} 封 · 会议 ${meetings} 场 · 空闲 ${freeHours} 小时`,
  draftReadyTitle: (person) => `回复草稿已就绪 · ${person}`,
  draftReadyLine: "确认后即可发送",
  disconnectedTitle: (account) => `${account} 已断开连接`,
  reconnectLine: "重新连接后即可继续分类此账户的邮件",
};

const COPY: Record<ShippedLanguage, KindPushCopy> = { en: EN, ko: KO, zh: ZH };

export function kindPushCopy(language: string | null | undefined): KindPushCopy {
  return COPY[toShippedLanguage(language)];
}
