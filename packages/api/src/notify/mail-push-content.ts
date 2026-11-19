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
 * and controls and format characters (bidi marks, zero-width) are dropped. Entities (&amp;) stay as
 * written: no surface decodes them. Every field is cut to a bounded prefix
 * before any pattern runs on it.
 */

import type { NotificationPresentation, NotificationReason } from "@klorn/contract";
import { boundedFromValue, displayNameOf, parseAddress } from "../mail/email-address.js";
import { type NotificationLanguage, notificationCopy } from "./notification-strings.js";
import { pushActionCopy } from "./push-action-strings.js";

export type MailPushLane = "PUSH" | "MEETING";

/** The reason line's cap, quotation marks included. */
export const MAIL_PUSH_REASON_MAX = 140;
const TITLE_MAX = 100;
const SUBJECT_MAX = 180;
/** How much of a field is read at all: the patterns below never see more. */
const SCAN_FACTOR = 4;

// C0 / C1 controls (newlines included) become spaces. Every format character
// goes: zero-width spaces and joiners, soft hyphen, the bidi marks, embeddings,
// overrides and isolates that can reorder what the user reads, and the Unicode
// tag characters — as evidence normalisation drops them (judge/v3/evidence.ts).
const CONTROL_CHARS = /\p{Cc}/gu;
const FORMAT_CHARS = /\p{Cf}/gu;
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
    .replace(FORMAT_CHARS, "")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The display name of a From header, else its address, else the header as
 * written. Parsed by mail/email-address.ts (linear; the one From parser),
 * over at most MAX_FROM_REGEX_CHARS of the header.
 */
export function senderDisplayName(from: string): string {
  const header = boundedFromValue(from).trim();
  return displayNameOf(header) ?? (parseAddress(header) || header);
}

/** The title: the display name, else the address, else the header — the first that is not empty once cleaned. */
function senderTitle(from: string): string {
  const header = boundedFromValue(from).trim();
  return (
    plainLine(displayNameOf(header), TITLE_MAX) ||
    plainLine(parseAddress(header), TITLE_MAX) ||
    plainLine(header, TITLE_MAX)
  );
}

export interface MailPushContent {
  title: string;
  body: string;
}

/** The text without the quotation marks around it, so a line never shows them twice. */
export function stripEdgeQuotes(text: string): string {
  return text.replace(EDGE_QUOTES, "").trim();
}

/** The verified quote as shown (no quotation marks), or "" — only when quotes may be shown. */
function shownQuote(reason: NotificationReason | null | undefined, allowQuote: boolean): string {
  if (!allowQuote || !reason?.verified || !reason.quote) return "";
  return stripEdgeQuotes(plainLine(reason.quote, MAIL_PUSH_REASON_MAX - 2));
}

/**
 * The judge's short reason, never the quote: notificationReason falls back to
 * the quote as the text when the item has no reason of its own, and that text
 * is mail text just the same.
 */
function reasonText(reason: NotificationReason | null | undefined): string {
  if (!reason) return "";
  const text = plainLine(reason.text, MAIL_PUSH_REASON_MAX);
  const quote = reason.quote ? plainLine(reason.quote, MAIL_PUSH_REASON_MAX) : "";
  return quote && text === quote ? "" : text;
}

/**
 * Line 2: the verified quote in curly quotes, else the short reason, else
 * nothing. The quote is mail text that would travel through Apple's and
 * Google's push services, so it shows only with `allowQuote` (the
 * NOTIFY_PUSH_QUOTE flag, config.ts pushQuoteOpenTo); without it a verified
 * reason shows its short text.
 */
export function reasonLine(
  reason: NotificationReason | null | undefined,
  allowQuote = false,
): string {
  const quote = shownQuote(reason, allowQuote);
  return quote ? `“${quote}”` : reasonText(reason);
}

export interface MailPushInput {
  from: string;
  subject: string | null | undefined;
  reason?: NotificationReason | null;
  language: NotificationLanguage | string;
  /** The verified quote may be shown (NOTIFY_PUSH_QUOTE open to the user). */
  allowQuote?: boolean;
}

function subjectLine(input: MailPushInput): string {
  return plainLine(input.subject, SUBJECT_MAX) || notificationCopy(input.language).noSubject;
}

export function mailPushContent(input: MailPushInput): MailPushContent {
  const title = senderTitle(input.from);
  const subject = subjectLine(input);
  const line2 = reasonLine(input.reason, input.allowQuote === true);
  return { title, body: line2 ? `${subject}\n${line2}` : subject };
}

/**
 * The From header's display name as the `senderDisplayName` field carries it:
 * cleaned onto one line; undefined when the header has none, or when it is
 * itself an address.
 */
export function presentedDisplayName(from: string | null | undefined): string | undefined {
  const name = plainLine(displayNameOf(boundedFromValue(from ?? "").trim()), TITLE_MAX);
  return name && !name.includes("@") ? name : undefined;
}

/**
 * The same mail as structured fields (NT0, contract NotificationPresentation):
 * what a client needs to lay the notification out as title = person, subtitle
 * = subject, body = the quote or the reason line. Cleaned exactly as
 * mailPushContent's text. `senderDisplayName` is the From header's display
 * name only (absent when it has none, or when it is itself an address).
 */
export function mailPushPresentation(
  input: MailPushInput & { lane: MailPushLane; threadId?: string | null },
): NotificationPresentation {
  const name = presentedDisplayName(input.from);
  const quote = shownQuote(input.reason, input.allowQuote === true);
  const reason = reasonText(input.reason);
  return {
    kind: input.lane === "MEETING" ? "meet" : "push",
    ...(name ? { senderDisplayName: name } : {}),
    subject: subjectLine(input),
    ...(quote ? { quote } : {}),
    ...(reason ? { reasonLine: reason } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
  };
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
