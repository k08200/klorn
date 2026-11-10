/**
 * Everything that shapes an outgoing message, shared by every provider: the
 * recipient checks and the one MIME builder.
 *
 * `mail/gmail.ts` used to own these. Gmail hands the builder's output to the
 * Gmail API (base64url `raw`, `buildPlainTextRawEmail`); the IMAP providers
 * (step B3 of docs/providers/unified-platform-plan.md) hand the same bytes to an
 * SMTP server and to an IMAP APPEND (`buildPlainTextMime`). They live here so
 * the two paths cannot drift: one set of header rules, one place where reply
 * headers are written (through `reply-headers.ts`).
 *
 * Gmail adds From, Date and Message-ID itself, and accepts 8-bit bodies over
 * HTTP. A message that leaves through SMTP or is stored by APPEND must carry its
 * own, and a server need not advertise 8BITMIME, so that flavour (the
 * `standalone` argument) also base64-encodes the text part, folds Subject into
 * encoded-words of at most 75 characters and long attachment names into RFC 2231
 * continuations, so no physical line exceeds 998 octets (RFC 5322 2.1.1) and the
 * ones it controls stay within 78. Without `standalone` the output is
 * byte-for-byte what `gmail.ts` produced before B3 (pinned against main's own
 * output in outbound-message.test.ts).
 */

import { randomUUID } from "node:crypto";

import type { MailAttachment, ReplyThreadingHeaders } from "./providers/types.js";
import { replyHeaderLines } from "./reply-headers.js";

/** RFC 5321 hard limit — reject before any parsing to keep validation O(1). */
const MAX_RECIPIENT_LENGTH = 320;

/**
 * Loose email address validator — we only need to catch agent hallucinations
 * where `to` is a bare domain ("accounts.google.com") or otherwise clearly not
 * an address. Gmail itself does strict RFC validation on send. Implemented
 * with string ops rather than regex because `to` is LLM-generated and we
 * want no regex backtracking on adversarial inputs (CodeQL js/polynomial-redos).
 */
export function extractAddress(raw: string): string {
  const trimmed = raw.trim();
  // "Name <addr@host>" form — take whatever is inside the final angle brackets
  if (trimmed.endsWith(">")) {
    const open = trimmed.lastIndexOf("<");
    if (open !== -1) return trimmed.slice(open + 1, -1).trim();
  }
  return trimmed;
}

export function looksLikeEmailAddress(raw: string): boolean {
  if (raw.length > MAX_RECIPIENT_LENGTH) return false;
  const addr = extractAddress(raw);
  if (addr.length === 0 || addr.length > MAX_RECIPIENT_LENGTH) return false;
  const at = addr.indexOf("@");
  if (at <= 0 || at !== addr.lastIndexOf("@")) return false; // need exactly one @, not at start
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  if (local.length === 0 || domain.length === 0) return false;
  if (!domain.includes(".")) return false;
  // No whitespace in either part
  for (const part of [local, domain]) {
    for (let i = 0; i < part.length; i++) {
      const ch = part.charCodeAt(i);
      if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) return false;
    }
  }
  return true;
}

/** Local-parts / subdomains that should never receive an auto-reply — responses
 *  either bounce or land in an unmonitored inbox (security-alert /
 *  transactional domains). Matched against extracted address parts, not the
 *  raw input, so there's no regex-on-user-input risk. */
const NO_REPLY_TOKENS = [
  "no-reply",
  "noreply",
  "do-not-reply",
  "donotreply",
  "mailer-daemon",
  "postmaster",
  "notification",
  "notifications",
  "alert",
  "alerts",
  "security",
];

export function isNoReplyAddress(raw: string): boolean {
  const addr = extractAddress(raw).toLowerCase();
  const at = addr.indexOf("@");
  if (at === -1) return false;
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  // Check local-part exact match OR any leading subdomain label
  if (NO_REPLY_TOKENS.includes(local)) return true;
  for (const label of domain.split(".")) {
    if (NO_REPLY_TOKENS.includes(label)) return true;
  }
  return false;
}

/** What the IMAP providers answer for an address that is valid but not a plain ASCII one. */
export const PLAIN_ADDRESS_ONLY_MESSAGE =
  "Klorn can only use a plain address (letters, digits and . _ + - before the @).";

/** What every provider answers for a recipient that is not an address. */
export function invalidAddressMessage(to: string): string {
  return `Invalid email address: "${to}". Use a full address like local@domain, not a domain such as accounts.google.com.`;
}

/**
 * The single-recipient guard of a send, as an error message or `null`. One copy
 * for every provider: a comma or semicolon means multiple addresses — reject it
 * so the angle-bracket display-name trick
 * (`a@x.com, evil@y.com <legit@z.com>`, whose addr-spec passes the check below)
 * can't smuggle an extra recipient into the To header. Wording is the one Gmail's
 * `sendEmail` has always answered.
 */
export function checkSendRecipient(to: string): string | null {
  if (to.includes(",") || to.includes(";")) {
    return "Send to one recipient at a time (no commas or semicolons in the address).";
  }
  if (!looksLikeEmailAddress(to)) return invalidAddressMessage(to);
  if (isNoReplyAddress(to)) {
    return `This address (${to}) is a no-reply system sender, so Klorn will not send a reply.`;
  }
  return null;
}

// What an SMTP command may carry: the RFC 5322 "atext" set plus the dot, ASCII
// only. No quoting, no comments, no brackets, no domain literals — an address
// needing any of those is refused rather than interpreted.
const SMTP_LOCAL_CHARS = new Set(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&'*+/=?^_`{|}~.-",
);
const MAX_SMTP_LOCAL_LENGTH = 64; // RFC 5321 4.5.3.1.1
const MAX_SMTP_DOMAIN_LENGTH = 255; // RFC 5321 4.5.3.1.2
const MAX_DNS_LABEL_LENGTH = 63;

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    if (ch < 0x20 || ch === 0x7f) return true;
  }
  return false;
}

function isSafeLocalPart(local: string): boolean {
  if (local.length === 0 || local.length > MAX_SMTP_LOCAL_LENGTH) return false;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  for (const ch of local) if (!SMTP_LOCAL_CHARS.has(ch)) return false;
  return true;
}

function isSafeLabel(label: string): boolean {
  if (label.length === 0 || label.length > MAX_DNS_LABEL_LENGTH) return false;
  if (label.startsWith("-") || label.endsWith("-")) return false;
  for (const ch of label) {
    const isAlnum =
      (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9");
    if (!isAlnum && ch !== "-") return false;
  }
  return true;
}

function isSafeDomain(domain: string): boolean {
  if (domain.length > MAX_SMTP_DOMAIN_LENGTH) return false;
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every(isSafeLabel)) return false;
  // A top-level label with no letter is an IP-address lookalike, not a domain.
  return /[A-Za-z]/.test(labels[labels.length - 1]);
}

/**
 * The bare addr-spec to put in an SMTP envelope, or `null`. The value is about
 * to be written into `RCPT TO:<...>` / `MAIL FROM:<...>` by a library that
 * parses it, so this is stricter than `looksLikeEmailAddress`: a single ASCII
 * addr-spec of dot-atoms, nothing quoted, bracketed, commented or internationalized,
 * and no control character anywhere in the input (not even in a display name).
 */
export function toSmtpAddress(raw: string): string | null {
  if (typeof raw !== "string" || raw.length > MAX_RECIPIENT_LENGTH) return null;
  if (hasControlCharacter(raw)) return null;
  const addr = extractAddress(raw);
  const at = addr.indexOf("@");
  if (at < 1 || at !== addr.lastIndexOf("@")) return null;
  if (!isSafeLocalPart(addr.slice(0, at)) || !isSafeDomain(addr.slice(at + 1))) return null;
  return addr;
}

const FALLBACK_MESSAGE_ID_DOMAIN = "klorn.local";

/** `<uuid@domain>` with the domain of `address` (letters, digits, dots, hyphens only). */
export function newMessageId(address: string): string {
  const at = address.lastIndexOf("@");
  const domain = at === -1 ? "" : address.slice(at + 1).replace(/[^A-Za-z0-9.-]/g, "");
  return `<${randomUUID()}@${domain || FALLBACK_MESSAGE_ID_DOMAIN}>`;
}

function encodeSubject(subject: string): string {
  return `=?UTF-8?B?${Buffer.from(safeHeaderValue(subject)).toString("base64")}?=`;
}

function safeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function wrapBase64(value: string): string {
  return value.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

function safeAsciiFilename(filename: string): string {
  const fallback = filename
    .replace(/[\r\n"]/g, "")
    .replace(/[^\x20-\x7E]+/g, "_")
    .trim();
  return fallback || "attachment";
}

/**
 * Reduce a client-supplied attachment Content-Type to a clean RFC 2045
 * type/subtype token. `mimeType` is the only attachment value that reaches a
 * MIME header without sanitization; busboy already strips CR/LF (sub-part
 * headers are line-delimited), but this drops parameters, quotes, and any
 * non-token characters so a malformed upload type can't shape the header we
 * emit. Falls back to a safe default when the value isn't a valid type/subtype.
 */
export function safeMimeType(raw: string): string {
  const token = safeHeaderValue(raw).split(";")[0].trim().toLowerCase();
  const cleaned = token.replace(/[^a-z0-9!#$&^_.+/-]/g, "");
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(cleaned)
    ? cleaned
    : "application/octet-stream";
}

/**
 * The headers a message needs when no service adds them for it (SMTP, IMAP
 * APPEND). `from` is the sending mailbox as a plain address; `messageId` comes
 * from `newMessageId`. Passing this also selects the base64 text part.
 */
export interface StandaloneHeaders {
  from: string;
  messageId: string;
  date: Date;
}

// Standalone folding limits. An encoded-word is at most 75 characters (RFC 2047
// 2); 42 bytes of text become a 68-character word, so "Subject: " plus one word
// is 77 characters, inside the 78-character line target.
const MAX_SUBJECT_WORD_BYTES = 42;
const MAX_ASCII_NAME_LENGTH = 40;
const MAX_NAME_EXTENSION_LENGTH = 10;
/** Percent-encoded characters per RFC 2231 continuation segment. */
const MAX_ENCODED_NAME_SEGMENT = 60;
const MAX_LINE_LENGTH = 78;

/** The subject as encoded-words, cut on code-point boundaries so none splits a character. */
function subjectWords(subject: string): string[] {
  const words: string[] = [];
  let current = "";
  let bytes = 0;
  for (const ch of safeHeaderValue(subject)) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > MAX_SUBJECT_WORD_BYTES) {
      words.push(current);
      current = "";
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  if (current !== "") words.push(current);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word).toString("base64")}?=`);
}

/** The ASCII `filename=` fallback, capped, keeping a short extension. */
function asciiFallbackName(ascii: string): string {
  if (ascii.length <= MAX_ASCII_NAME_LENGTH) return ascii;
  const dot = ascii.lastIndexOf(".");
  const extension =
    dot > 0 && ascii.length - dot <= MAX_NAME_EXTENSION_LENGTH ? ascii.slice(dot) : "";
  return ascii.slice(0, MAX_ASCII_NAME_LENGTH - extension.length) + extension;
}

/** encodeURIComponent, plus the four characters RFC 5987 attr-char excludes but it leaves bare. */
function encodeParameterValue(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Split percent-encoded text into segments of at most `size`, never inside a %XX. */
function segmentsOf(encoded: string, size: number): string[] {
  const segments: string[] = [];
  let start = 0;
  while (start < encoded.length) {
    let end = Math.min(start + size, encoded.length);
    if (end < encoded.length) {
      if (encoded[end - 1] === "%") end -= 1;
      else if (encoded[end - 2] === "%") end -= 2;
    }
    segments.push(encoded.slice(start, end));
    start = end;
  }
  return segments;
}

/** A header as one line when it fits, else folded after the first parameter separator. */
function foldParameters(head: string, parameters: readonly string[]): string[] {
  const single = `${head} ${parameters.join("; ")}`;
  if (single.length <= MAX_LINE_LENGTH) return [single];
  return [
    `${head}`,
    ...parameters.map((parameter, i) => ` ${parameter}${i < parameters.length - 1 ? ";" : ""}`),
  ];
}

function standaloneAttachmentHeaders(mimeType: string, filename: string): string[] {
  const ascii = asciiFallbackName(safeAsciiFilename(filename));
  const encoded = encodeParameterValue(filename);
  const nameParameters =
    encoded.length <= MAX_ENCODED_NAME_SEGMENT
      ? [`filename*=UTF-8''${encoded}`]
      : segmentsOf(encoded, MAX_ENCODED_NAME_SEGMENT).map((segment, i) =>
          i === 0 ? `filename*0*=UTF-8''${segment}` : `filename*${i}*=${segment}`,
        );
  return [
    ...foldParameters(`Content-Type: ${safeMimeType(mimeType)};`, [`name="${ascii}"`]),
    "Content-Transfer-Encoding: base64",
    ...foldParameters("Content-Disposition: attachment;", [
      `filename="${ascii}"`,
      ...nameParameters,
    ]),
  ];
}

/** RFC 5322 date-time in UTC, with a numeric zone (`+0000`, not the obsolete `GMT`). */
function formatDateHeader(date: Date): string {
  return date.toUTCString().replace("GMT", "+0000");
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n|\r|\n/g, "\r\n");
}

function textPartLines(body: string, standalone: StandaloneHeaders | undefined): string[] {
  if (!standalone) {
    return ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", body];
  }
  const encoded = Buffer.from(normalizeNewlines(body), "utf-8").toString("base64");
  return [
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(encoded),
  ];
}

function attachmentLines(
  attachments: readonly MailAttachment[],
  boundary: string,
  standalone: boolean,
): string[] {
  return attachments.flatMap((attachment) => {
    const filename = safeHeaderValue(attachment.filename || "attachment");
    const asciiFilename = safeAsciiFilename(filename);
    const headers = standalone
      ? standaloneAttachmentHeaders(attachment.mimeType, filename)
      : [
          `Content-Type: ${safeMimeType(attachment.mimeType)}; name="${asciiFilename}"`,
          "Content-Transfer-Encoding: base64",
          `Content-Disposition: attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        ];
    return [`--${boundary}`, ...headers, "", wrapBase64(attachment.content.toString("base64"))];
  });
}

/** From, To, Subject, then (standalone only) Date and Message-ID, then reply headers. */
function addressingLines(
  to: string,
  subject: string,
  threading: ReplyThreadingHeaders | undefined,
  standalone: StandaloneHeaders | undefined,
): string[] {
  return [
    ...(standalone ? [`From: ${safeHeaderValue(standalone.from)}`] : []),
    `To: ${safeHeaderValue(to)}`,
    standalone
      ? `Subject: ${subjectWords(subject).join("\r\n ")}`
      : `Subject: ${encodeSubject(subject)}`,
    ...(standalone
      ? [
          `Date: ${formatDateHeader(standalone.date)}`,
          `Message-ID: ${safeHeaderValue(standalone.messageId)}`,
        ]
      : []),
    ...replyHeaderLines(threading),
  ];
}

/**
 * The plain-text (or multipart/mixed, with attachments) message as RFC 5322
 * text. Every field passes through `safeHeaderValue` and reply headers through
 * `reply-headers.ts`, so no value can start another header line.
 */
export function buildPlainTextMime(
  to: string,
  subject: string,
  body: string,
  attachments: readonly MailAttachment[] = [],
  threading?: ReplyThreadingHeaders,
  standalone?: StandaloneHeaders,
): string {
  const head = addressingLines(to, subject, threading, standalone);
  const endOfMessage = standalone ? [""] : [];
  if (attachments.length === 0) {
    return [...head, "MIME-Version: 1.0", ...textPartLines(body, standalone), ...endOfMessage].join(
      "\r\n",
    );
  }

  const boundary = `klorn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  return [
    ...head,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    ...textPartLines(body, standalone),
    ...attachmentLines(attachments, boundary, standalone !== undefined),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

/** The Gmail API form of `buildPlainTextMime`: the same bytes, base64url-encoded. */
export function buildPlainTextRawEmail(
  to: string,
  subject: string,
  body: string,
  attachments: readonly MailAttachment[] = [],
  threading?: ReplyThreadingHeaders,
): string {
  return Buffer.from(buildPlainTextMime(to, subject, body, attachments, threading)).toString(
    "base64url",
  );
}
