/**
 * Copy of the reply-wait reminders (NT0 copy spec, 2026-11-17): the single
 * "wait" notification, the multi-mail digest and the follow-up suggestion.
 * Klorn's own voice, so it follows the user's notification language.
 *
 * Product languages are en / ko / zh (founder decision 2026-11-17). Anything
 * else — a removed language, a regional tag that is not Chinese, nothing —
 * reads English: a missing translation must never cost a notification.
 */

import { type ShippedLanguage, toShippedLanguage } from "../shipped-languages.js";

export type ReplyWaitLanguage = ShippedLanguage;

/** A shipped language (shipped-languages.ts); anything else reads English. */
export function replyWaitLanguage(raw: string | null | undefined): ReplyWaitLanguage {
  return toShippedLanguage(raw);
}

export interface ReplyWaitCopy {
  /** Digest title: N mails still need the user's reply. */
  digestTitle: (count: number) => string;
  /** Last digest line when more mails wait than are listed. */
  more: (count: number) => string;
  /** The single reminder's wait line: how long the mail has waited. */
  waiting: (days: number) => string;
  noSubject: string;
  unknownSender: string;
  followUpTitle: (count: number) => string;
  followUpIntro: (days: number) => string;
}

const EN: ReplyWaitCopy = {
  digestTitle: (n) => `${n} ${n === 1 ? "reply" : "replies"} waiting`,
  more: (n) => `+${n} more`,
  waiting: (d) => `Waiting ${d} ${d === 1 ? "day" : "days"} for your reply`,
  noSubject: "(no subject)",
  unknownSender: "Unknown sender",
  followUpTitle: (n) => `${n} ${n === 1 ? "email" : "emails"} may need a follow-up`,
  followUpIntro: (d) => `No reply in ${d}+ days. Want Klorn to draft a follow-up?`,
};

const KO: ReplyWaitCopy = {
  digestTitle: (n) => `답장 대기 ${n}건`,
  more: (n) => `외 ${n}건`,
  waiting: (d) => `${d}일째 답장 대기`,
  noSubject: "(제목 없음)",
  unknownSender: "알 수 없는 발신자",
  followUpTitle: (n) => `후속 연락이 필요할 수 있는 메일 ${n}건`,
  followUpIntro: (d) => `${d}일 넘게 답장하지 않은 메일입니다. Klorn이 후속 메일 초안을 쓸까요?`,
};

const ZH: ReplyWaitCopy = {
  digestTitle: (n) => `${n}封邮件待回复`,
  more: (n) => `另外${n}封`,
  waiting: (d) => `已等待回复${d}天`,
  noSubject: "（无主题）",
  unknownSender: "未知发件人",
  followUpTitle: (n) => `${n}封邮件可能需要跟进`,
  followUpIntro: (d) => `超过${d}天未回复。要让 Klorn 起草跟进邮件吗？`,
};

const COPY: Record<ReplyWaitLanguage, ReplyWaitCopy> = { en: EN, ko: KO, zh: ZH };

export function replyWaitCopy(language: string | null | undefined): ReplyWaitCopy {
  return COPY[replyWaitLanguage(language)];
}
