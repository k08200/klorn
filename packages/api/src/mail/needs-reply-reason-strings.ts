/**
 * Reader copy for `EmailMessage.needsReplyReason`.
 *
 * The column holds a snake_case code from classifyNeedsReplyFromSignals
 * (email-priority.ts), never prose. Clients that printed the column verbatim
 * showed "action_items_present" in every language, so the detail route also
 * sends this line, rendered per request in the reader's language.
 *
 * Only the codes that explain WHY a reply is needed have copy. The negative
 * codes ("no_reply_signal", "self_sent", ...) resolve to null: the reader can
 * still mark a mail as needing a reply (looksReplyNeeded), and a line saying
 * "no reply signal" under "needs reply" would contradict it.
 */

import {
  type NotificationLanguage,
  resolveNotificationLanguage,
} from "../notify/notification-strings.js";

export const NEEDS_REPLY_REASON_COPY = {
  action_items_present: {
    en: "Asks you to do something",
    ko: "처리할 요청이 들어 있음",
    ja: "対応が必要な依頼があります",
    zh: "包含需要你处理的请求",
    es: "Te pide que hagas algo",
    fr: "Vous demande de faire quelque chose",
    de: "Bittet dich, etwas zu erledigen",
  },
  reply_language_in_subject: {
    en: "The subject asks for a reply",
    ko: "제목에서 회신을 요청함",
    ja: "件名で返信を求めています",
    zh: "主题要求回复",
    es: "El asunto pide una respuesta",
    fr: "L'objet demande une réponse",
    de: "Der Betreff bittet um eine Antwort",
  },
  urgent_human_context: {
    en: "Urgent mail from a person",
    ko: "사람이 보낸 급한 메일",
    ja: "人からの急ぎのメール",
    zh: "来自真人的紧急邮件",
    es: "Correo urgente de una persona",
    fr: "E-mail urgent d'une personne",
    de: "Dringende Mail von einer Person",
  },
} as const satisfies Record<string, Record<NotificationLanguage, string>>;

type NeedsReplyReasonCode = keyof typeof NEEDS_REPLY_REASON_COPY;

function hasCopy(code: string): code is NeedsReplyReasonCode {
  return Object.hasOwn(NEEDS_REPLY_REASON_COPY, code);
}

/** The reader line for a stored code, or null when there is nothing to say. */
export function needsReplyReasonText(
  code: string | null | undefined,
  language?: string | null,
): string | null {
  if (!code || !hasCopy(code)) return null;
  return NEEDS_REPLY_REASON_COPY[code][resolveNotificationLanguage(language)];
}
