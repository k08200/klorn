/**
 * Push titles for a Slack PUSH episode, in every notification language
 * (notify/notification-strings.ts NOTIFICATION_LANGUAGES). Typed by the
 * language union, so a new language fails the build here until translated.
 */

import type { SlackConversationKind } from "../judge/email-classifier.js";
import {
  type NotificationLanguage,
  resolveNotificationLanguage,
} from "../notify/notification-strings.js";

type KindTitles = Record<SlackConversationKind, string>;

const TITLES: Record<NotificationLanguage, KindTitles> = {
  en: {
    dm: "Direct message",
    group_dm: "Group message",
    mention: "You were mentioned",
    opt_in: "Followed channel",
  },
  ko: {
    dm: "다이렉트 메시지",
    group_dm: "그룹 메시지",
    mention: "회원님 멘션",
    opt_in: "팔로우한 채널",
  },
  ja: {
    dm: "ダイレクトメッセージ",
    group_dm: "グループメッセージ",
    mention: "あなたへのメンション",
    opt_in: "フォロー中のチャンネル",
  },
  zh: { dm: "私信", group_dm: "群组消息", mention: "有人提到了你", opt_in: "关注的频道" },
  es: {
    dm: "Mensaje directo",
    group_dm: "Mensaje de grupo",
    mention: "Te mencionaron",
    opt_in: "Canal que sigues",
  },
  fr: {
    dm: "Message direct",
    group_dm: "Message de groupe",
    mention: "On vous a mentionné",
    opt_in: "Canal suivi",
  },
  de: {
    dm: "Direktnachricht",
    group_dm: "Gruppennachricht",
    mention: "Du wurdest erwähnt",
    opt_in: "Gefolgter Kanal",
  },
};

export function slackPushTitle(kind: SlackConversationKind, language: string): string {
  return `Slack · ${TITLES[resolveNotificationLanguage(language)][kind]}`;
}
