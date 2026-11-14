/**
 * Judges one Slack episode with the existing judge (docs/providers/slack.md
 * §8): judgeEmail with a `slack` item, so the Slack prompt and untrusted
 * wrapping apply and the email-address shortcuts do not. The call carries the
 * user's id and BYOK credentials, so the per-user daily cost cap, the
 * background pacer and the BYOK exemption apply unchanged.
 */

import type { LiveTier } from "@klorn/contract";
import type { SlackConversationKind } from "../judge/email-classifier.js";
import { EMPTY_JUDGE_CONTEXT, judgeEmail } from "../judge/poc-judge.js";
import { toLiveTier } from "../judge/tiers.js";
import { getUserLlmCredentials } from "../llm/llm-credentials.js";
import { getUserNotificationLanguage } from "../notify/notification-strings.js";
import { slackPlainText } from "./text.js";

/** The short reason kept on the episode after the text expires. */
export const SLACK_REASON_MAX = 200;
const MESSAGE_CHARS = 600;
const EPISODE_CHARS = 1500;

export function slackConversationKind(
  channelType: string,
  mentionsUser: boolean,
): SlackConversationKind {
  if (channelType === "im") return "dm";
  if (channelType === "mpim") return "group_dm";
  return mentionsUser ? "mention" : "opt_in";
}

/** The episode's messages as plain lines, oldest first, capped. */
export function slackEpisodeText(messages: ReadonlyArray<{ text: string }>): string {
  return messages
    .map((m) => slackPlainText(m.text, MESSAGE_CHARS))
    .filter((line) => line.length > 0)
    .join("\n")
    .slice(0, EPISODE_CHARS);
}

export async function judgeSlackEpisode(input: {
  userId: string;
  channelType: string;
  mentionsUser: boolean;
  messages: ReadonlyArray<{ text: string }>;
}): Promise<{ tier: LiveTier; reason: string }> {
  const text = slackEpisodeText(input.messages);
  const [credentials, language] = await Promise.all([
    getUserLlmCredentials(input.userId),
    getUserNotificationLanguage(input.userId),
  ]);
  const judgement = await judgeEmail(
    {
      from: "",
      subject: "",
      snippet: text.split("\n")[0] ?? "",
      body: text,
      slack: { conversation: slackConversationKind(input.channelType, input.mentionsUser) },
    },
    input.userId,
    EMPTY_JUDGE_CONTEXT,
    credentials,
    undefined,
    undefined,
    language,
  );
  return {
    tier: toLiveTier(judgement.tier),
    reason: judgement.reason.slice(0, SLACK_REASON_MAX),
  };
}
