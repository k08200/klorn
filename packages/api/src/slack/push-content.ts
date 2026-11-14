/**
 * The push for a Slack PUSH episode (sibling of notify/mail-push-content.ts):
 * title "Slack · <how it reached you>", body the first message as one plain
 * line and the judge's short reason. Slack markup is rendered linearly
 * (text.ts) and the result cleaned by the mail push's own plainLine.
 */

import type { SlackConversationKind } from "../judge/email-classifier.js";
import { MAIL_PUSH_REASON_MAX, plainLine } from "../notify/mail-push-content.js";
import { slackPushTitle } from "./push-strings.js";
import { slackPlainText } from "./text.js";

const PREVIEW_MAX = 180;

export function slackPushContent(input: {
  kind: SlackConversationKind;
  preview: string;
  reason: string;
  language: string;
}): { title: string; body: string } {
  const preview = plainLine(slackPlainText(input.preview, PREVIEW_MAX * 2), PREVIEW_MAX);
  const reason = plainLine(input.reason, MAIL_PUSH_REASON_MAX);
  const body = reason ? `${preview}\n${reason}` : preview;
  return { title: slackPushTitle(input.kind, input.language), body };
}
