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

import { type ShippedLanguage, toShippedLanguage } from "../shipped-languages.js";

export const NEEDS_REPLY_REASON_COPY = {
  action_items_present: {
    en: "Asks you to do something",
    ko: "처리할 요청이 들어 있음",
    zh: "包含需要你处理的请求",
  },
  reply_language_in_subject: {
    en: "The subject asks for a reply",
    ko: "제목에서 회신을 요청함",
    zh: "主题要求回复",
  },
  urgent_human_context: {
    en: "Urgent mail from a person",
    ko: "사람이 보낸 급한 메일",
    zh: "来自真人的紧急邮件",
  },
} as const satisfies Record<string, Record<ShippedLanguage, string>>;

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
  return NEEDS_REPLY_REASON_COPY[code][toShippedLanguage(language)];
}
