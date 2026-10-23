/**
 * Resend's parsed content of a received message → the row the shared store
 * writes (step E1b of docs/providers/unified-platform-plan.md). Pure.
 *
 * - Only Resend's parsed fields are read; no raw MIME is ever parsed here
 *   (#1466/#1467: a parser on the event loop is a denial of service).
 * - Every field is sender-controlled input that reached Resend, so each is
 *   type-checked and capped as IMAP caps it, and NUL is removed (Postgres text
 *   cannot hold it, and a refused row would drop the message).
 * - `htmlBody` is empty, like IMAP: rendering this source's HTML is reviewed in
 *   E4. Attachments are E4 too.
 */

import type { EmailReceivedEvent, GetReceivingEmailResponseSuccess } from "resend";
import { htmlToPlainText } from "./email-text.js";
import type { GmailRawEmail } from "./gmail-fetch.js";
import { capStored, envelopeSubject, MAX_STORED_CC_LENGTH } from "./imap-envelope.js";
import { parseListUnsubscribe } from "./list-unsubscribe.js";
import { MAX_STORED_BODY_CHARS, snippetFromBody } from "./stored-mail-text.js";

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

/** `klorn:<address>:<email_id>`, the IMAP and Outlook namespace pattern. */
export function klornMessageId(address: string, emailId: string): string {
  return `klorn:${address}:${emailId}`;
}

function stripNul(value: string): string {
  return value.includes("\u0000") ? value.replaceAll("\u0000", "") : value;
}

/** A sender-controlled string, capped first (bounded work), then NUL-free. */
function storedText(value: unknown, max: number): string {
  return typeof value === "string" ? stripNul(capStored(value, max)) : "";
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

function receivedAtOf(event: ResendReceivedEventData): Date {
  const date = new Date(event.created_at);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

export function resendToRawEmail(
  content: ResendReceivedContent,
  event: ResendReceivedEventData,
  recipientAddress: string,
): GmailRawEmail & { authentication: MailAuthentication | null } {
  const headers = content.headers;
  const body = bodyOf(content);
  const listUnsubscribeHeader = header(headers, "list-unsubscribe");
  const listUnsubscribe = parseListUnsubscribe(
    listUnsubscribeHeader,
    header(headers, "list-unsubscribe-post"),
  );
  return {
    gmailId: klornMessageId(recipientAddress, event.email_id),
    threadId: null,
    from: storedText(header(headers, "from") ?? content.from, MAX_STORED_CC_LENGTH).trim(),
    to: storedText(header(headers, "to") ?? joined(content.to), MAX_STORED_CC_LENGTH),
    cc: storedText(header(headers, "cc") ?? joined(content.cc), MAX_STORED_CC_LENGTH),
    // Bounded before envelopeSubject trims it and caps it at IMAP's limit.
    subject: envelopeSubject(storedText(content.subject, MAX_STORED_BODY_CHARS)),
    snippet: snippetFromBody(body) ?? "",
    body,
    htmlBody: "",
    labels: ["INBOX", "UNREAD"],
    isRead: false,
    isStarred: false,
    receivedAt: receivedAtOf(event),
    attachments: [],
    hasListUnsubscribe: Boolean(listUnsubscribeHeader),
    listUnsubscribeMailto: listUnsubscribe.mailto,
    listUnsubscribeUrl: listUnsubscribe.url,
    listUnsubscribeOneClick: listUnsubscribe.oneClick,
    authentication: whitelistAuthentication(content.authentication),
  };
}
