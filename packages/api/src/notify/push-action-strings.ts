/**
 * Copy for the action buttons on a mail notification (decision N1,
 * 2026-11-08) and the reminder their "Later" sets, in the user's notification
 * language. Kept apart from notification-strings.ts so that table stays the
 * notification bodies only.
 */

import { type NotificationLanguage, resolveNotificationLanguage } from "./notification-strings.js";

export interface PushActionCopy {
  /** Opens the mail with the reply composer focused. Sending stays manual. */
  reply: string;
  /** A reminder about the mail, later today. */
  later: string;
  /** Moves the mail to QUEUE (phone only; the web keeps it in-app). */
  notUrgent: string;
  /** Title of the reminder "Later" sets. The subject stays as the mail wrote it. */
  laterReminderTitle: (subject: string) => string;
}

const COPY: Record<NotificationLanguage, PushActionCopy> = {
  en: {
    reply: "Reply",
    later: "Later",
    notUrgent: "Not urgent",
    laterReminderTitle: (subject) => `Follow up: ${subject}`,
  },
  ko: {
    reply: "답장",
    later: "나중에",
    notUrgent: "급하지 않음",
    laterReminderTitle: (subject) => `다시 보기: ${subject}`,
  },
  ja: {
    reply: "返信",
    later: "あとで",
    notUrgent: "急ぎではない",
    laterReminderTitle: (subject) => `あとで確認: ${subject}`,
  },
  zh: {
    reply: "回复",
    later: "稍后",
    notUrgent: "不紧急",
    laterReminderTitle: (subject) => `稍后处理：${subject}`,
  },
  es: {
    reply: "Responder",
    later: "Más tarde",
    notUrgent: "No urgente",
    laterReminderTitle: (subject) => `Seguimiento: ${subject}`,
  },
  fr: {
    reply: "Répondre",
    later: "Plus tard",
    notUrgent: "Pas urgent",
    laterReminderTitle: (subject) => `À suivre : ${subject}`,
  },
  de: {
    reply: "Antworten",
    later: "Später",
    notUrgent: "Nicht dringend",
    laterReminderTitle: (subject) => `Nachfassen: ${subject}`,
  },
};

export function pushActionCopy(language: string | null | undefined): PushActionCopy {
  return COPY[resolveNotificationLanguage(language)];
}
