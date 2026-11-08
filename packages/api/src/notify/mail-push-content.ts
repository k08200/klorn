/**
 * What a notification about one mail says and offers (decision N1, LOCKED
 * 2026-11-08 — every surface the same way):
 *   - title: the sender's display name only (the OS already shows the app name);
 *   - body: line 1 the subject (the localized stand-in when empty), line 2 the
 *     judge's one-line reason when there is one;
 *   - web actions: Reply and Later for a PUSH mail, Later for a MEETING mail.
 *     No Silent / Mute: a misclick there is too costly. "Not urgent" stays on
 *     the phone and in-app (Chrome / Windows show two actions reliably).
 *
 * Sender, subject and reason are untrusted (the mail, or a model reading it).
 * Notifications render plain text everywhere, so nothing is escaped; each
 * field is folded onto ONE line, so a mail cannot forge an extra line that
 * looks like Klorn's reason, and bidi / control characters are dropped.
 */

import { type NotificationLanguage, notificationCopy } from "./notification-strings.js";
import { pushActionCopy } from "./push-action-strings.js";

export type MailPushLane = "PUSH" | "MEETING";

export const MAIL_PUSH_REASON_MAX = 140;
const TITLE_MAX = 100;
const SUBJECT_MAX = 180;

// C0/C1 controls (newlines included) and the bidi embedding / override /
// isolate marks, which can reorder what the user reads.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function oneLine(value: string | null | undefined, max: number): string {
  const text = (value ?? "").replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The display name of a From header, else the header as written. */
export function senderDisplayName(from: string): string {
  const angle = from.indexOf("<");
  const name = angle > 0 ? from.slice(0, angle).trim().replace(/^"|"$/g, "") : from.trim();
  return name || from;
}

export interface MailPushContent {
  title: string;
  body: string;
}

export function mailPushContent(input: {
  from: string;
  subject: string | null | undefined;
  reason?: string | null;
  language: NotificationLanguage | string;
}): MailPushContent {
  const title = oneLine(senderDisplayName(input.from), TITLE_MAX) || oneLine(input.from, TITLE_MAX);
  const subject = oneLine(input.subject, SUBJECT_MAX) || notificationCopy(input.language).noSubject;
  const reason = oneLine(input.reason, MAIL_PUSH_REASON_MAX);
  return { title, body: reason ? `${subject}\n${reason}` : subject };
}

export interface WebPushAction {
  action: "reply" | "later";
  title: string;
}

export function mailPushWebActions(
  lane: MailPushLane,
  language: NotificationLanguage | string,
): WebPushAction[] {
  const copy = pushActionCopy(language);
  const later: WebPushAction = { action: "later", title: copy.later };
  return lane === "PUSH" ? [{ action: "reply", title: copy.reply }, later] : [later];
}

/** The web reader on that mail with the reply composer focused (#1632). */
export function mailPushReplyPath(emailId: string): string {
  return `/email/${encodeURIComponent(emailId)}?focus=reply`;
}
