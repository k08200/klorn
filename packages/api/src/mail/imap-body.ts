/**
 * IMAP body decoding.
 *
 * The poll fetches BODY[TEXT]: the message body WITHOUT its top-level headers.
 * For a multipart message that is MIME boundaries plus base64 or
 * quoted-printable parts; for a single-part one it is still transfer-encoded in
 * the charset named by the missing header. It used to be stored as UTF-8 text
 * as-is, so `body` held raw MIME (production 2026-10-16: 50 of 50 iCloud rows)
 * and the judge, the snippet and the reader all saw it.
 *
 * The poll now also fetches the top-level Content-Type and
 * Content-Transfer-Encoding. They are put back in front of BODY[TEXT] and the
 * result goes through a MIME parser (postal-mime, the imapflow author's), which
 * also decodes the part charsets (EUC-KR for Naver).
 *
 * Bounded: at most IMAP_DECODE_MAX_BYTES is parsed (the stored body keeps
 * 50 000 characters anyway). Text parts come first in practice, so a large
 * attachment behind them is cut off, not decoded on the API event loop.
 *
 * A cut can land mid-base64-group, which the parser decodes to NUL; Postgres
 * rejects NUL in text, so every result is NUL-stripped (the row would otherwise
 * fail to persist). A parsed message with neither a text nor an HTML part
 * (attachments only) has no body, rather than its base64. Never throws:
 * anything the parser cannot read keeps the old raw text.
 */

import PostalMime from "postal-mime";
import sanitizeHtml from "sanitize-html";

export const IMAP_DECODE_MAX_BYTES = 256 * 1024;

const CRLF = "\r\n";

function stripNul(value: string): string {
  return value.includes("\u0000") ? value.replaceAll("\u0000", "") : value;
}

function rawText(text: Buffer | undefined): string {
  return text ? stripNul(text.toString("utf8")) : "";
}

function htmlToText(html: string): string {
  const stripped = sanitizeHtml(html, {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: "discard",
    nonTextTags: ["style", "script", "textarea", "option", "noscript", "head", "title"],
  });
  // Line by line, no backtracking regex (this runs on sender-controlled text):
  // collapse runs of spaces and tabs, keep at most one blank line in a row.
  const lines: string[] = [];
  for (const line of stripped.split("\n")) {
    const tidy = line.replace(/[ \t\r]+/g, " ").trim();
    if (tidy === "" && (lines.length === 0 || lines[lines.length - 1] === "")) continue;
    lines.push(tidy);
  }
  return lines.join("\n").trim();
}

/** Decoded plain text of an IMAP message body; the raw text if it cannot be decoded. */
export async function decodeImapText(
  headers: Buffer | undefined,
  text: Buffer | undefined,
): Promise<string> {
  if (!text || text.length === 0) return "";
  if (!headers || headers.length === 0) return rawText(text);

  const head = headers.toString("latin1").trimEnd();
  const body = text.subarray(0, IMAP_DECODE_MAX_BYTES);
  const message = Buffer.concat([Buffer.from(head + CRLF + CRLF, "latin1"), body]);
  try {
    const parsed = await PostalMime.parse(message);
    const plain = stripNul(parsed.text ?? "").trim();
    if (plain) return plain;
    return parsed.html ? htmlToText(stripNul(parsed.html)) : "";
  } catch {
    return rawText(text);
  }
}
