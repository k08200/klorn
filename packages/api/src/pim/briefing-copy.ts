/**
 * The daily briefing's own words, per notification language: the push title,
 * the section headers the server renders around the model's answer, the quiet
 * morning card, and the language line the prompt gives the model.
 *
 * Section headers keep the literal "Top 3" in every language: the web client
 * finds the Top 3 list by that token (use-briefing.ts extractTopActions).
 */

import type { NotificationLanguage } from "../notify/notification-strings.js";

export interface BriefingCopy {
  /** Push and bell title for a delivered briefing. */
  pushTitle: string;
  top: string;
  connected: string;
  other: string;
  /** The quiet card's first line: nothing new, nothing scheduled or due. */
  quietHeadline: string;
  /** Header over PUSH mail that is still open from before. */
  stillOpen: string;
  /** Instruction to the model: the language to write in. */
  languageLine: string;
}

const COPY: Record<NotificationLanguage, BriefingCopy> = {
  en: {
    pushTitle: "Daily briefing ready",
    top: "Top 3 Today",
    connected: "Connected items",
    other: "Everything else",
    quietHeadline:
      "Nothing new since your last briefing, and nothing scheduled or due in the next day.",
    stillOpen: "Still open",
    languageLine: "Write every field in English.",
  },
  ko: {
    pushTitle: "오늘의 브리핑",
    top: "오늘의 Top 3",
    connected: "연결된 항목",
    other: "그 밖의 것",
    quietHeadline: "지난 브리핑 이후 새로 온 것이 없고, 하루 안에 잡힌 일정이나 마감도 없습니다.",
    stillOpen: "아직 열려 있는 메일",
    languageLine:
      "Write every field in Korean (자연스러운 한국어). Keep product/tool names as-is. The quote stays in the mail's own language.",
  },
  ja: {
    pushTitle: "今日のブリーフィング",
    top: "今日の Top 3",
    connected: "関連する項目",
    other: "その他",
    quietHeadline:
      "前回のブリーフィング以降、新しいものはありません。1日以内の予定や期限もありません。",
    stillOpen: "まだ対応中のメール",
    languageLine:
      "Write every field in Japanese (自然な日本語). Keep product/tool names as-is. The quote stays in the mail's own language.",
  },
  zh: {
    pushTitle: "今日简报",
    top: "今日 Top 3",
    connected: "相关事项",
    other: "其他",
    quietHeadline: "自上次简报以来没有新内容，一天内也没有日程或截止事项。",
    stillOpen: "仍待处理的邮件",
    languageLine:
      "Write every field in Simplified Chinese. Keep product/tool names as-is. The quote stays in the mail's own language.",
  },
  es: {
    pushTitle: "Tu resumen del día",
    top: "Top 3 de hoy",
    connected: "Elementos relacionados",
    other: "Todo lo demás",
    quietHeadline:
      "Nada nuevo desde tu último resumen, y nada programado ni pendiente en el próximo día.",
    stillOpen: "Aún abiertos",
    languageLine:
      "Write every field in Spanish. Keep product/tool names as-is. The quote stays in the mail's own language.",
  },
  fr: {
    pushTitle: "Votre briefing du jour",
    top: "Top 3 du jour",
    connected: "Éléments liés",
    other: "Tout le reste",
    quietHeadline:
      "Rien de nouveau depuis votre dernier briefing, et rien de prévu ni d'échéance dans la journée à venir.",
    stillOpen: "Encore ouverts",
    languageLine:
      "Write every field in French. Keep product/tool names as-is. The quote stays in the mail's own language.",
  },
  de: {
    pushTitle: "Dein Tagesbriefing",
    top: "Top 3 heute",
    connected: "Zusammenhänge",
    other: "Alles andere",
    quietHeadline:
      "Nichts Neues seit deinem letzten Briefing, und in den nächsten 24 Stunden ist nichts geplant oder fällig.",
    stillOpen: "Noch offen",
    languageLine:
      "Write every field in German. Keep product/tool names as-is. The quote stays in the mail's own language.",
  },
};

export function briefingCopy(lang: NotificationLanguage): BriefingCopy {
  return COPY[lang] ?? COPY.en;
}

/**
 * Whether a stored briefing is the quiet card, in any language — so a later
 * caller that finds the day's note announces it without a push too.
 */
export function isQuietBriefing(content: string): boolean {
  return Object.values(COPY).some((copy) => content.startsWith(copy.quietHeadline));
}
