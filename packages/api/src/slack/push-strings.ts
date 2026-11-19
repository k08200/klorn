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
  zh: { dm: "私信", group_dm: "群组消息", mention: "有人提到了你", opt_in: "关注的频道" },
};

/** Every Slack push title starts with this; disconnect finds Slack bell rows by it. */
export const SLACK_TITLE_PREFIX = "Slack · ";
/** The bell row type of a Slack push (notify.ts); the Windows catch-up reads it too. */
export const SLACK_NOTIFICATION_TYPE = "slack";
/**
 * dedupeKey prefix of a Slack bell row a push that will not ring wrote (quiet
 * hours, the urgent-mail opt-out): "slack:<episodeId>". Such a row rings once
 * the gate allows: the Windows catch-up toasts it and the server's quiet-hours
 * summary counts it (notify/desktop-catchup.ts, notify/quiet-hours-summary.ts).
 */
export const SLACK_ROW_KEY_PREFIX = "slack:";
/**
 * dedupeKey prefix of a Slack bell row held for good: the Slack ring cap, the
 * interrupt budget or a late re-judge (`ring: false`) said no ring. Never rings
 * later, so it is named apart from SLACK_ROW_KEY_PREFIX ("slack-" is not "slack:").
 */
export const SLACK_HELD_ROW_KEY_PREFIX = "slack-held:";

export function slackPushTitle(kind: SlackConversationKind, language: string): string {
  return `${SLACK_TITLE_PREFIX}${TITLES[resolveNotificationLanguage(language)][kind]}`;
}
