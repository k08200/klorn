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
 * Bounded: at most IMAP_DECODE_MAX_BYTES is parsed. Text parts come first in
 * practice, so a large attachment behind them is cut off, not decoded on the
 * API event loop. Never throws: anything unusable keeps the old raw text.
 */

import PostalMime from "postal-mime";
import sanitizeHtml from "sanitize-html";

export const IMAP_DECODE_MAX_BYTES = 1024 * 1024;

const CRLF = "\r\n";

function rawText(text: Buffer | undefined): string {
  return text ? text.toString("utf8") : "";
}

function htmlToText(html: string): string {
  const stripped = sanitizeHtml(html, {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: "discard",
    nonTextTags: ["style", "script", "textarea", "option", "noscript", "head", "title"],
  });
  return stripped
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();
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
    const plain = parsed.text?.trim();
    if (plain) return plain;
    const fromHtml = parsed.html ? htmlToText(parsed.html) : "";
    return fromHtml || rawText(text);
  } catch {
    return rawText(text);
  }
}
