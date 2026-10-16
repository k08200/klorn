/**
 * IMAP body decoding: a bounded, linear MIME reader for the text of a message.
 *
 * The poll fetches BODY[TEXT]: the message body WITHOUT its top-level headers.
 * For a multipart message that is MIME boundaries plus base64 or
 * quoted-printable parts; for a single-part one it is still transfer-encoded in
 * the charset named by the missing header. It used to be stored as UTF-8 text
 * as-is, so `body` held raw MIME (production 2026-10-16: 50 of 50 iCloud rows)
 * and the judge, the snippet and the reader all saw it.
 *
 * The poll now also fetches the top-level Content-Type and
 * Content-Transfer-Encoding, and this reader walks the MIME tree from them to
 * the first text/plain part (else the first text/html), undoing the transfer
 * encoding and the charset (TextDecoder: EUC-KR for Naver, ISO-2022-JP, …).
 *
 * Why not a full MIME parser: sender-controlled input on the single API event
 * loop. postal-mime (measured 2026-10-16) is super-linear on a `<` flood in an
 * HTML part (64 KiB: 2.1 s), on many parts and on nested message/rfc822 (out of
 * heap at 256 KiB). Everything here is a forward scan, with hard caps: input
 * bytes, header bytes, nesting depth and part count. message/rfc822 and
 * attachments are skipped, not parsed.
 *
 * Results are NUL-stripped (a cut can land mid-base64-group, and Postgres
 * rejects NUL in text). A message whose tree has no text part has no body
 * rather than its base64. Never throws: on any error the old raw text is kept.
 */

import { htmlToPlainText } from "./email-text.js";

export const IMAP_DECODE_MAX_BYTES = 256 * 1024;
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_MIME_DEPTH = 4;
const MAX_MIME_PARTS = 64;
// RFC 2046 caps a boundary at 70 characters; a longer, sender-chosen one would
// make each delimiter search cost its length times the body.
const MAX_BOUNDARY_CHARS = 70;
// htmlToPlainText runs sanitize-html, whose cost grows faster than linearly in
// nesting; an HTML-only body is cut before it (the stored body keeps 50 000
// characters, and markup outweighs text several times over).
const MAX_HTML_TO_TEXT_CHARS = 64 * 1024;

interface MimeHeaders {
  contentType: string;
  params: Map<string, string>;
  encoding: string;
  attachment: boolean;
}

interface FoundText {
  plain?: string;
  html?: string;
}

function stripNul(value: string): string {
  return value.includes("\u0000") ? value.replaceAll("\u0000", "") : value;
}

function rawText(text: Buffer): string {
  return stripNul(text.toString("utf8"));
}

/** "name: value" lines, folded lines unfolded; lower-cased names, first one wins. */
function parseHeaderLines(block: string): Map<string, string> {
  const fields = new Map<string, string>();
  let name = "";
  let value = "";
  const flush = () => {
    if (name && !fields.has(name)) fields.set(name, value.trim());
  };
  for (const line of block.split("\n")) {
    const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
    if ((clean.startsWith(" ") || clean.startsWith("\t")) && name) {
      value += ` ${clean.trim()}`;
      continue;
    }
    flush();
    const colon = clean.indexOf(":");
    name = colon > 0 ? clean.slice(0, colon).trim().toLowerCase() : "";
    value = colon > 0 ? clean.slice(colon + 1) : "";
  }
  flush();
  return fields;
}

/** `type/sub; key=value; key="quoted"` → the type and its parameters. */
function parseParams(value: string): { main: string; params: Map<string, string> } {
  const segments: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    if (ch === 0x22) quoted = !quoted;
    if (ch === 0x3b && !quoted) {
      segments.push(value.slice(start, i));
      start = i + 1;
    }
  }
  segments.push(value.slice(start));
  const params = new Map<string, string>();
  for (const segment of segments.slice(1)) {
    const eq = segment.indexOf("=");
    if (eq <= 0) continue;
    const key = segment.slice(0, eq).trim().toLowerCase();
    const raw = segment.slice(eq + 1).trim();
    params.set(
      key,
      raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw,
    );
  }
  return { main: (segments[0] ?? "").trim().toLowerCase(), params };
}

function toMimeHeaders(fields: Map<string, string>): MimeHeaders {
  const { main, params } = parseParams(fields.get("content-type") ?? "text/plain");
  const disposition = parseParams(fields.get("content-disposition") ?? "").main;
  return {
    contentType: main || "text/plain",
    params,
    encoding: (fields.get("content-transfer-encoding") ?? "").trim().toLowerCase(),
    attachment: disposition === "attachment",
  };
}

function hexValue(code: number | undefined): number {
  if (code === undefined) return -1;
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x37;
  if (code >= 0x61 && code <= 0x66) return code - 0x57;
  return -1;
}

function decodeQuotedPrintable(input: Buffer): Buffer {
  const out = Buffer.alloc(input.length);
  let j = 0;
  for (let i = 0; i < input.length; i++) {
    const byte = input[i] as number;
    if (byte !== 0x3d) {
      out[j++] = byte;
      continue;
    }
    const high = hexValue(input[i + 1]);
    const low = hexValue(input[i + 2]);
    if (input[i + 1] === 0x0d && input[i + 2] === 0x0a) {
      i += 2; // soft line break
    } else if (input[i + 1] === 0x0a) {
      i += 1;
    } else if (high !== -1 && low !== -1) {
      out[j++] = high * 16 + low;
      i += 2;
    } else {
      out[j++] = byte;
    }
  }
  return out.subarray(0, j);
}

function decodeTransfer(body: Buffer, encoding: string): Buffer {
  // Node's base64 decoder skips whitespace and stray characters in one pass.
  if (encoding === "base64") return Buffer.from(body.toString("latin1"), "base64");
  if (encoding === "quoted-printable") return decodeQuotedPrintable(body);
  return body;
}

function decodeCharset(bytes: Buffer, charset: string | undefined): string {
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return bytes.toString("utf8"); // unknown label
  }
}

/** Split a part into its header block (capped) and its content. */
function splitHeaders(part: Buffer): { fields: Map<string, string>; content: Buffer } {
  if (part[0] === 0x0a) return { fields: new Map(), content: part.subarray(1) };
  if (part[0] === 0x0d && part[1] === 0x0a) return { fields: new Map(), content: part.subarray(2) };
  const crlf = part.indexOf("\r\n\r\n");
  const lf = part.indexOf("\n\n");
  const useCrlf = crlf !== -1 && (lf === -1 || crlf <= lf);
  const end = useCrlf ? crlf : lf;
  if (end === -1) return { fields: new Map(), content: part };
  const block = part.subarray(0, Math.min(end, MAX_HEADER_BYTES)).toString("latin1");
  return { fields: parseHeaderLines(block), content: part.subarray(end + (useCrlf ? 4 : 2)) };
}

/** The parts between `--boundary` delimiter lines, at most `budget.parts` of them. */
function splitMultipart(body: Buffer, boundary: string, budget: { parts: number }): Buffer[] {
  const delimiter = Buffer.from(`--${boundary}`, "latin1");
  const parts: Buffer[] = [];
  let partStart = -1;
  let from = 0;
  while (budget.parts > 0) {
    const at = body.indexOf(delimiter, from);
    if (at === -1) break;
    from = at + delimiter.length;
    if (at !== 0 && body[at - 1] !== 0x0a) continue; // not at a line start
    if (partStart !== -1) {
      let end = at;
      if (body[end - 1] === 0x0a) end--;
      if (body[end - 1] === 0x0d) end--;
      parts.push(body.subarray(partStart, Math.max(partStart, end)));
      budget.parts--;
    }
    if (body[from] === 0x2d && body[from + 1] === 0x2d) return parts; // close delimiter
    const lineEnd = body.indexOf(0x0a, from);
    if (lineEnd === -1) return parts;
    partStart = lineEnd + 1;
  }
  if (partStart !== -1 && budget.parts > 0) {
    parts.push(body.subarray(partStart)); // the input was cut off mid-part
    budget.parts--;
  }
  return parts;
}

function readEntity(
  headers: MimeHeaders,
  body: Buffer,
  depth: number,
  budget: { parts: number },
): FoundText {
  if (headers.attachment) return {};
  const type = headers.contentType;
  if (type === "text/plain" || type === "text/html") {
    const text = decodeCharset(
      decodeTransfer(body, headers.encoding),
      headers.params.get("charset"),
    );
    return type === "text/plain" ? { plain: text } : { html: text };
  }
  const boundary = headers.params.get("boundary");
  if (!type.startsWith("multipart/") || depth >= MAX_MIME_DEPTH) return {};
  if (!boundary || boundary.length > MAX_BOUNDARY_CHARS) return {};
  const found: FoundText = {};
  for (const part of splitMultipart(body, boundary, budget)) {
    const { fields, content } = splitHeaders(part);
    const inner = readEntity(toMimeHeaders(fields), content, depth + 1, budget);
    if (inner.plain?.trim()) return { plain: inner.plain };
    if (found.html === undefined && inner.html !== undefined) found.html = inner.html;
  }
  return found;
}

/** Decoded plain text of an IMAP message body; the raw text if it cannot be decoded. */
export function decodeImapText(headers: Buffer | undefined, text: Buffer | undefined): string {
  if (!text || text.length === 0) return "";
  if (!headers || headers.length === 0) return rawText(text);
  try {
    const top = toMimeHeaders(
      parseHeaderLines(headers.subarray(0, MAX_HEADER_BYTES).toString("latin1")),
    );
    const found = readEntity(top, text.subarray(0, IMAP_DECODE_MAX_BYTES), 0, {
      parts: MAX_MIME_PARTS,
    });
    const plain = stripNul(found.plain ?? "").trim();
    if (plain) return plain;
    if (!found.html) return "";
    return stripNul(htmlToPlainText(stripNul(found.html).slice(0, MAX_HTML_TO_TEXT_CHARS)));
  } catch {
    return rawText(text);
  }
}
