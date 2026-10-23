/**
 * Resend's parsed content of a received message → the row the shared store
 * writes (step E1b of docs/providers/unified-platform-plan.md). Pure, and the
 * same for every recipient of the event, so it runs once per event.
 *
 * - Only Resend's parsed fields are read; no raw MIME is ever parsed here
 *   (#1466/#1467: a parser on the event loop is a denial of service). RFC 2047
 *   encoded-words in From/To/Cc display names are decoded by a linear decoder,
 *   after the raw value was parsed (decoded-address-header.ts).
 * - Every field is sender-controlled input that reached Resend, so each is
 *   type-checked and capped as IMAP caps it, and NUL is removed (Postgres text
 *   cannot hold it, and a refused row would drop the message).
 * - `htmlBody` is empty, like IMAP: rendering this source's HTML is reviewed in
 *   E4. Attachments are E4 too. The content is fetched with `html_format: cid`,
 *   so inline images do not crowd the text out of the HTML fallback.
 */

import type { EmailReceivedEvent, GetReceivingEmailResponseSuccess } from "resend";
import { decodedAddressList, decodedMailbox, MAX_HEADER_CHARS } from "./decoded-address-header.js";
import { htmlToPlainText } from "./email-text.js";
import type { GmailRawEmail } from "./gmail-fetch.js";
import { capStored, envelopeSubject, MAX_STORED_SUBJECT_LENGTH } from "./imap-envelope.js";
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
 * The store's `userEmail` (its self-sent comparison) for a copy delivered to
 * `address`: the address only when DKIM and DMARC pass. Otherwise "", which
 * matches no sender and which persistGmailEmail keeps as is (`??` replaces
 * only null), where null would make it compare with the account's sign-in
 * address. So an unauthenticated From of either address is never the user's.
 */
export function selfSentAddress(
  authentication: MailAuthentication | null,
  address: string,
): string {
  return isAuthenticatedSender(authentication) ? address : "";
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

/**
 * An address header as stored (decoded-address-header.ts): display names decoded
 * after the raw value was parsed, bounded so that no cut can change a mailbox.
 */
function addressHeader(value: string, kind: "mailbox" | "list"): string {
  return kind === "mailbox" ? decodedMailbox(value) : decodedAddressList(value);
}

/** The header names the mapper reads; nothing else in `headers` is looked at. */
const NEEDED_HEADERS = ["from", "to", "cc", "list-unsubscribe", "list-unsubscribe-post"] as const;
type NeededHeader = (typeof NEEDED_HEADERS)[number];
const NEEDED: ReadonlySet<string> = new Set(NEEDED_HEADERS);
const LONGEST_NEEDED = Math.max(...NEEDED_HEADERS.map((name) => name.length));

/**
 * At most this many header keys are examined. A real message has a few dozen;
 * a needed header past the cap is not read, and the content's own `from`, `to`
 * and `cc` fields cover the addresses.
 */
export const MAX_HEADER_KEYS = 2_000;

export interface HeaderIndex {
  values: Readonly<Partial<Record<NeededHeader, string>>>;
  /** Keys looked at (the structural bound tests read it). */
  examined: number;
}

/**
 * The needed headers by lowercase name, in one pass over at most MAX_HEADER_KEYS
 * own keys: the first string value of a name wins (as a reader of the first
 * matching header would). Before, every lookup walked and lowercased every key,
 * nine times per event: 1M keys took 16 s.
 */
export function indexHeaders(headers: unknown): HeaderIndex {
  if (typeof headers !== "object" || headers === null) return { values: {}, examined: 0 };
  const fields = headers as Record<string, unknown>;
  const values: Partial<Record<NeededHeader, string>> = {};
  let examined = 0;
  for (const key of Object.keys(fields)) {
    if (examined >= MAX_HEADER_KEYS) break;
    examined += 1;
    if (key.length > LONGEST_NEEDED) continue;
    const name = key.toLowerCase();
    if (!NEEDED.has(name) || name in values) continue;
    const value = fields[key];
    if (typeof value === "string") values[name as NeededHeader] = value;
  }
  return { values, examined };
}

/** One index per fetched content: oversizedHeaders and resendToRawEmail share it. */
const indexes = new WeakMap<object, HeaderIndex["values"]>();

function headersOf(content: ResendReceivedContent): HeaderIndex["values"] {
  const cached = indexes.get(content);
  if (cached) return cached;
  const { values } = indexHeaders(content.headers);
  indexes.set(content, values);
  return values;
}

/**
 * An array of addresses joined with ", ", built only until it passes the header
 * ceiling (a longer result is refused whole by the caller anyway).
 */
function joined(list: unknown): string {
  if (!Array.isArray(list)) return "";
  let value = "";
  for (const item of list) {
    if (typeof item !== "string") continue;
    value = value ? `${value}, ${item}` : item;
    if (value.length > MAX_HEADER_CHARS) break;
  }
  return value;
}

/** A header's raw value, unless it is over the ceiling (then null: never parsed). */
function bounded(value: string | null): string | null {
  return value !== null && value.length > MAX_HEADER_CHARS ? null : value;
}

function rawFrom(content: ResendReceivedContent): string {
  return headersOf(content).from ?? (typeof content.from === "string" ? content.from : "");
}

function rawList(content: ResendReceivedContent, name: "to" | "cc"): string {
  return headersOf(content)[name] ?? joined(content[name]);
}

/**
 * The address headers this content holds over MAX_HEADER_CHARS, which the
 * mapper does not parse: the caller reports them (`header-oversize`).
 */
export function oversizedHeaders(content: ResendReceivedContent): string[] {
  const values: Array<[string, string | null]> = [
    ["from", rawFrom(content)],
    ["to", rawList(content, "to")],
    ["cc", rawList(content, "cc")],
    ["list-unsubscribe", headersOf(content)["list-unsubscribe"] ?? null],
  ];
  return values
    .filter(([, value]) => value !== null && value.length > MAX_HEADER_CHARS)
    .map(([name]) => name);
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
  const headers = headersOf(content);
  const body = bodyOf(content);
  const listUnsubscribeHeader = bounded(headers["list-unsubscribe"] ?? null);
  const listUnsubscribe = parseListUnsubscribe(
    listUnsubscribeHeader,
    bounded(headers["list-unsubscribe-post"] ?? null),
  );
  return {
    gmailId: klornMessageId(event.email_id),
    threadId: null,
    from: addressHeader(rawFrom(content), "mailbox").trim(),
    to: addressHeader(rawList(content, "to"), "list"),
    cc: addressHeader(rawList(content, "cc"), "list"),
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
