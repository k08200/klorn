/**
 * What a notification about one mail says and offers (decision N1, LOCKED
 * 2026-11-08 — every surface the same way). mailPushContent is the ONE
 * formatter: web push, FCM / APNs, Telegram, the live desktop frame, the
 * Windows catch-up and the quiet-hours summary all carry its output, so the
 * Mac app's banner function mirrors exactly these fields:
 *   - title: the sender's display name only (the OS already shows the app
 *     name); the bare address when the From header has no name;
 *   - body: line 1 the subject (the localized stand-in when empty), line 2 the
 *     reason line when there is one: the verified quote from the mail in
 *     curly quotes (NC1, notification-reason.ts), otherwise the judge's short
 *     reason. Nothing else from the mail body is ever included;
 *   - web actions: Reply and Later for a PUSH mail, Later for a MEETING mail.
 *     No Silent / Mute: a misclick there is too costly. "Not urgent" stays on
 *     the phone and in-app (Chrome / Windows show two actions reliably).
 *
 * Sender, subject, reason and quote are untrusted (the mail, or a model
 * reading it). Notifications render plain text everywhere, so nothing is
 * escaped: HTML tags and comments are removed, each field is folded onto ONE
 * line, so a mail cannot forge an extra line that looks like Klorn's reason,
 * and C0 / C1 controls and bidi marks are dropped. Entities (&amp;) stay as
 * written: no surface decodes them. Every field is cut to a bounded prefix
 * before any pattern runs on it.
 */

import type { NotificationReason } from "@klorn/contract";
import { type NotificationLanguage, notificationCopy } from "./notification-strings.js";
import { pushActionCopy } from "./push-action-strings.js";

export type MailPushLane = "PUSH" | "MEETING";

/** The reason line's cap, quotation marks included. */
export const MAIL_PUSH_REASON_MAX = 140;
const TITLE_MAX = 100;
const SUBJECT_MAX = 180;
/** How much of a field is read at all: the patterns below never see more. */
const SCAN_FACTOR = 4;

// C0/C1 controls (newlines included) and the bidi embedding / override /
// isolate marks, which can reorder what the user reads.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// A tag (<b>, </a>, <img src=x>) or a comment / declaration (<!-- -->,
// <!doctype>, <?xml?>). "a < b" is not a tag: a tag name starts right after
// the bracket. Linear: [^<>]* stops at the next bracket.
const HTML_TAG = /<(?:\/?[a-z]|[!?])[^<>]*>/gi;
// Quotation marks around a quote, so the line never shows them twice.
const EDGE_QUOTES = /^["“”'‘’「」]+|["“”'‘’「」]+$/g;

/** Plain text on one line, capped at `max` (ellipsis included). */
export function plainLine(value: string | null | undefined, max: number): string {
  const text = (value ?? "")
    .slice(0, max * SCAN_FACTOR)
    .replace(HTML_TAG, " ")
    .replace(UNSAFE_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// "Name <addr>": the display name, and the address in the last brackets.
const ADDRESS_FORM = /^(.*?)\s*<([^<>]*)>\s*$/s;
const FROM_SCAN = 1_000;

/** The display name of a From header, else its address, else the header as written. */
export function senderDisplayName(from: string): string {
  const header = from.slice(0, FROM_SCAN).trim();
  const match = ADDRESS_FORM.exec(header);
  if (!match) return header;
  const name = (match[1] ?? "").trim().replace(/^"|"$/g, "").trim();
  return name || (match[2] ?? "").trim() || header;
}

export interface MailPushContent {
  title: string;
  body: string;
}

/** Line 2: the verified quote in curly quotes, else the short reason, else nothing. */
export function reasonLine(reason: NotificationReason | null | undefined): string {
  if (!reason) return "";
  if (reason.verified && reason.quote) {
    const quote = plainLine(reason.quote, MAIL_PUSH_REASON_MAX - 2)
      .replace(EDGE_QUOTES, "")
      .trim();
    if (quote) return `“${quote}”`;
  }
  return plainLine(reason.text, MAIL_PUSH_REASON_MAX);
}

export function mailPushContent(input: {
  from: string;
  subject: string | null | undefined;
  reason?: NotificationReason | null;
  language: NotificationLanguage | string;
}): MailPushContent {
  const title =
    plainLine(senderDisplayName(input.from), TITLE_MAX) || plainLine(input.from, TITLE_MAX);
  const subject =
    plainLine(input.subject, SUBJECT_MAX) || notificationCopy(input.language).noSubject;
  const line2 = reasonLine(input.reason);
  return { title, body: line2 ? `${subject}\n${line2}` : subject };
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
