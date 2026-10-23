/**
 * Resend's parsed content of a received message → the row the shared store
 * writes (step E1b of docs/providers/unified-platform-plan.md). Pure, and the
 * same for every recipient of the event, so it runs once per event.
 *
 * - Only Resend's parsed fields are read; no raw MIME is ever parsed here
 *   (#1466/#1467: a parser on the event loop is a denial of service). RFC 2047
 *   encoded-words in From/To/Cc are decoded by a linear decoder.
 * - Every field is sender-controlled input that reached Resend, so each is
 *   type-checked and capped as IMAP caps it, and NUL is removed (Postgres text
 *   cannot hold it, and a refused row would drop the message).
 * - `htmlBody` is empty, like IMAP: rendering this source's HTML is reviewed in
 *   E4. Attachments are E4 too. The content is fetched with `html_format: cid`,
 *   so inline images do not crowd the text out of the HTML fallback.
 */

import type { EmailReceivedEvent, GetReceivingEmailResponseSuccess } from "resend";
import { htmlToPlainText } from "./email-text.js";
import { decodeEncodedWords } from "./encoded-words.js";
import type { GmailRawEmail } from "./gmail-fetch.js";
import {
  capStored,
  envelopeSubject,
  MAX_STORED_CC_LENGTH,
  MAX_STORED_SUBJECT_LENGTH,
} from "./imap-envelope.js";
import { parseListUnsubscribe } from "./list-unsubscribe.js";
import { MAX_STORED_BODY_CHARS, snippetFromBody } from "./stored-mail-text.js";
import { stripNul } from "./text-normalize.js";

/**
 * GET /emails/receiving/{id}. Resend documents `authentication` ({spf, dkim,
 * dmarc}) on this response, but the SDK's type (6.20.0) does not declare it.
 */
export type ResendReceivedContent = GetReceivingEmailResponseSuccess & {
  authentication?: unknown;
};

export type ResendReceivedEventData = EmailReceivedEvent["data"];

/** The verdicts stored as they are; anything else is stored as "unknown". */
export const AUTH_VERDICTS: ReadonlySet<string> = new Set([
  "pass",
  "fail",
  "softfail",
  "neutral",
  "none",
  "temperror",
  "permerror",
]);
export const UNKNOWN_VERDICT = "unknown";

export type MailAuthentication = { spf: string; dkim: string; dmarc: string };

const AUTH_FIELDS = ["spf", "dkim", "dmarc"] as const;
/** A raw address header is decoded from at most this much; the result is capped as IMAP's. */
const MAX_HEADER_DECODE_CHARS = 4 * MAX_STORED_CC_LENGTH;

function verdict(value: unknown): string {
  if (typeof value !== "string") return UNKNOWN_VERDICT;
  const normalized = value.trim().toLowerCase();
  return AUTH_VERDICTS.has(normalized) ? normalized : UNKNOWN_VERDICT;
}

/** Each field whitelisted; null when Resend sent no authentication object. */
export function whitelistAuthentication(raw: unknown): MailAuthentication | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const fields = raw as Record<string, unknown>;
  const [spf, dkim, dmarc] = AUTH_FIELDS.map((field) => verdict(fields[field]));
  return { spf, dkim, dmarc };
}

/** Whether the sender's domain is authenticated: DKIM and DMARC both pass. */
export function isAuthenticatedSender(authentication: MailAuthentication | null): boolean {
  return authentication?.dkim === "pass" && authentication.dmarc === "pass";
}

/**
 * `klorn:<email_id>`: unique per user through (userId, gmailId), since an account
 * has one Klorn address. No address in it, so the shared store's logs and Sentry
 * `extra` (which carry gmailId) never carry one.
 */
export function klornMessageId(emailId: string): string {
  return `klorn:${emailId}`;
}

/** A sender-controlled string, capped first (bounded work), then NUL-free. */
function storedText(value: unknown, max: number): string {
  return typeof value === "string" ? stripNul(capStored(value, max)) : "";
}

/** An address header: encoded-words decoded from a bounded input, then capped like IMAP. */
function addressHeader(value: string): string {
  return storedText(
    decodeEncodedWords(capStored(value, MAX_HEADER_DECODE_CHARS)),
    MAX_STORED_CC_LENGTH,
  );
}

/** A header value by case-insensitive name; only a string counts. */
function header(headers: unknown, name: string): string | null {
  if (typeof headers !== "object" || headers === null) return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === "string") return value;
  }
  return null;
}

function joined(list: unknown): string {
  return Array.isArray(list) ? list.filter((v) => typeof v === "string").join(", ") : "";
}

/** `text`, else the HTML as plain text, capped at IMAP's limit. */
function bodyOf(content: ResendReceivedContent): string {
  const { text, html } = content as { text: unknown; html: unknown };
  if (typeof text === "string" && text.trim()) return storedText(text, MAX_STORED_BODY_CHARS);
  if (typeof html === "string") return storedText(htmlToPlainText(html), MAX_STORED_BODY_CHARS);
  return "";
}

function nulFree(value: string | null): string | null {
  return value === null ? null : stripNul(value);
}

/** `receivedAt` is the caller's: the event's receive time, already validated. */
export function resendToRawEmail(
  content: ResendReceivedContent,
  event: Pick<ResendReceivedEventData, "email_id" | "created_at">,
  receivedAt: Date = new Date(event.created_at),
): GmailRawEmail & { authentication: MailAuthentication | null } {
  const headers = content.headers;
  const body = bodyOf(content);
  const listUnsubscribeHeader = header(headers, "list-unsubscribe");
  const listUnsubscribe = parseListUnsubscribe(
    listUnsubscribeHeader,
    header(headers, "list-unsubscribe-post"),
  );
  return {
    gmailId: klornMessageId(event.email_id),
    threadId: null,
    from: addressHeader(
      header(headers, "from") ?? storedText(content.from, MAX_HEADER_DECODE_CHARS),
    ).trim(),
    to: addressHeader(header(headers, "to") ?? joined(content.to)),
    cc: addressHeader(header(headers, "cc") ?? joined(content.cc)),
    // Capped at the subject limit before envelopeSubject trims it.
    subject: envelopeSubject(storedText(content.subject, MAX_STORED_SUBJECT_LENGTH)),
    snippet: snippetFromBody(body) ?? "",
    body,
    htmlBody: "",
    labels: ["INBOX", "UNREAD"],
    isRead: false,
    isStarred: false,
    receivedAt: Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
    attachments: [],
    hasListUnsubscribe: Boolean(listUnsubscribeHeader),
    listUnsubscribeMailto: nulFree(listUnsubscribe.mailto),
    listUnsubscribeUrl: nulFree(listUnsubscribe.url),
    listUnsubscribeOneClick: listUnsubscribe.oneClick,
    authentication: whitelistAuthentication(content.authentication),
  };
}
