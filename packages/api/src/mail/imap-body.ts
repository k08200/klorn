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
 * the first text/plain part and the first text/html part, undoing the transfer
 * encoding and the charset (TextDecoder: EUC-KR for Naver, ISO-2022-JP, …). The
 * text is the plain part (else the HTML projected to text); the HTML part is the
 * row's htmlBody. Attachments, parts named like files, and message/rfc822 are
 * skipped here (imap-attachments.ts lists them).
 *
 * Why not a full MIME parser: sender-controlled input on the single API event
 * loop. postal-mime (measured 2026-10-16) is super-linear on a `<` flood in an
 * HTML part (64 KiB: 2.1 s), on many parts and on nested message/rfc822 (out of
 * heap at 256 KiB). Everything here is a forward scan, with hard caps: input
 * bytes, header bytes, nesting depth, parts per level and parts visited.
 *
 * Results are NUL-stripped (a cut can land mid-base64-group, and Postgres
 * rejects NUL in text). A message whose tree has no text part has no body
 * rather than its base64. Never throws: on any error the old raw text is kept.
 */

import { htmlToPlainText } from "./email-text.js";
import { capStored } from "./imap-envelope.js";
import { stripNul } from "./text-normalize.js";

export const IMAP_DECODE_MAX_BYTES = 256 * 1024;
export const MAX_HEADER_BYTES = 8 * 1024;
// Real trees nest deeper than four (mixed > signed > mixed > related >
// alternative is five); each level rescans only its own part.
export const MAX_MIME_DEPTH = 8;
// Parts VISITED across the whole tree; each multipart level also lists at most
// this many children.
export const MAX_MIME_PARTS = 64;
// RFC 2046 caps a boundary at 70 characters; a longer, sender-chosen one would
// make each delimiter search cost its length times the body.
export const MAX_BOUNDARY_CHARS = 70;
// htmlToPlainText runs sanitize-html, whose cost grows faster than linearly in
// nesting, and the poll decodes its whole 50-message window every cycle: an
// HTML-only body is cut first (16K '<b>': 6 ms; 64K: up to ~110 ms). Long
// HTML-only mail keeps the start of its text.
const MAX_HTML_TO_TEXT_CHARS = 16 * 1024;
// Labels mail clients send that TextDecoder (WHATWG) does not know; its
// "euc-kr" is the windows-949 superset they all mean.
const CHARSET_ALIASES: ReadonlyMap<string, string> = new Map([
  ["cp949", "euc-kr"],
  ["ms949", "euc-kr"],
  ["x-windows-949", "euc-kr"],
  ["ks_c_5601", "euc-kr"],
  ["uhc", "euc-kr"],
]);
const HEADER_LINE = /^[!-9;-~]+:/; // a field name (printable, no colon), then ":"

interface MimeHeaders {
  contentType: string;
  params: Map<string, string>;
  encoding: string;
  attachment: boolean;
}

interface FoundText {
  plain?: string;
  html?: string;
  /** The HTML part ran into the end of a cut input: its text is usable, its markup is not stored. */
  htmlCut?: boolean;
}

interface WalkState {
  parts: number;
  /** The decoded input, and whether it is only the start of the body. */
  root: Buffer;
  cut: boolean;
}

function rawText(text: Buffer): string {
  return stripNul(text.subarray(0, IMAP_DECODE_MAX_BYTES).toString("utf8"));
}

/** "name: value" lines, folded lines unfolded; lower-cased names, first one wins. */
export function parseHeaderLines(block: string): Map<string, string> {
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
export function parseParams(value: string): { main: string; params: Map<string, string> } {
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
    const unquoted = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"');
    params.set(key, unquoted ? raw.slice(1, -1) : raw);
  }
  return { main: (segments[0] ?? "").trim().toLowerCase(), params };
}

/** A part named like a file is an attachment, whatever its disposition says. */
function isNamedPart(params: Map<string, string>, disposition: Map<string, string>): boolean {
  // RFC 2231 forms (`filename*=`, `filename*0*=`) name a file too (imap-attachments.ts).
  const names = (map: Map<string, string>, base: string) =>
    map.has(base) || map.has(`${base}*`) || map.has(`${base}*0`) || map.has(`${base}*0*`);
  return names(params, "name") || names(disposition, "filename") || names(disposition, "name");
}

function toMimeHeaders(fields: Map<string, string>): MimeHeaders {
  const { main, params } = parseParams(fields.get("content-type") ?? "text/plain");
  const disposition = parseParams(fields.get("content-disposition") ?? "");
  return {
    contentType: main || "text/plain",
    params,
    encoding: (fields.get("content-transfer-encoding") ?? "").trim().toLowerCase(),
    attachment: disposition.main === "attachment" || isNamedPart(params, disposition.params),
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
    let k = i + 1;
    while (input[k] === 0x20 || input[k] === 0x09) k++; // padding before a soft break
    const high = hexValue(input[i + 1]);
    const low = hexValue(input[i + 2]);
    if (input[k] === 0x0d && input[k + 1] === 0x0a) {
      i = k + 1; // soft line break
    } else if (input[k] === 0x0a) {
      i = k;
    } else if (high !== -1 && low !== -1) {
      out[j++] = high * 16 + low;
      i += 2;
    } else {
      out[j++] = byte;
    }
  }
  return out.subarray(0, j);
}

export function decodeTransfer(body: Buffer, encoding: string): Buffer {
  // Node's base64 decoder skips whitespace and stray characters in one pass.
  if (encoding === "base64") return Buffer.from(body.toString("latin1"), "base64");
  if (encoding === "quoted-printable") return decodeQuotedPrintable(body);
  return body;
}

export function decodeCharset(bytes: Buffer, charset: string | undefined): string {
  const label = (charset ?? "").trim().toLowerCase();
  try {
    return new TextDecoder(CHARSET_ALIASES.get(label) ?? (label || "utf-8")).decode(bytes);
  } catch {
    return bytes.toString("utf8"); // unknown label
  }
}

/**
 * Split a part into its header block (capped) and its content. A part with no
 * blank line is content without headers, unless it starts like a header line:
 * then the size cap cut it inside its headers and it has no content.
 */
export function splitHeaders(part: Buffer): { fields: Map<string, string>; content: Buffer } {
  if (part[0] === 0x0a) return { fields: new Map(), content: part.subarray(1) };
  if (part[0] === 0x0d && part[1] === 0x0a) return { fields: new Map(), content: part.subarray(2) };
  const crlf = part.indexOf("\r\n\r\n");
  const lf = part.indexOf("\n\n");
  const useCrlf = crlf !== -1 && (lf === -1 || crlf <= lf);
  const end = useCrlf ? crlf : lf;
  if (end === -1) {
    const cutInHeaders = HEADER_LINE.test(part.subarray(0, 80).toString("latin1"));
    return { fields: new Map(), content: cutInHeaders ? part.subarray(0, 0) : part };
  }
  const block = part.subarray(0, Math.min(end, MAX_HEADER_BYTES)).toString("latin1");
  return { fields: parseHeaderLines(block), content: part.subarray(end + (useCrlf ? 4 : 2)) };
}

/** What may follow `--boundary` on a delimiter line: padding, the line end, or "--". */
function endsDelimiter(body: Buffer, at: number): boolean {
  const next = body[at];
  return (
    next === undefined ||
    next === 0x0d ||
    next === 0x0a ||
    next === 0x20 ||
    next === 0x09 ||
    (next === 0x2d && body[at + 1] === 0x2d)
  );
}

/**
 * The parts between `--boundary` delimiter lines, at most MAX_MIME_PARTS of them.
 * `misses`, when given, caps the delimiter look-alikes skipped (shared by a whole
 * walk): a body made of `--<boundary>x` lines costs one search each, so a large
 * input must not be allowed an unbounded number of them.
 */
export function splitMultipart(
  body: Buffer,
  boundary: string,
  misses?: { left: number },
): Buffer[] {
  const delimiter = Buffer.from(`--${boundary}`, "latin1");
  const parts: Buffer[] = [];
  let partStart = -1;
  let from = 0;
  while (parts.length < MAX_MIME_PARTS) {
    const at = body.indexOf(delimiter, from);
    if (at === -1) break;
    from = at + delimiter.length;
    // Not at a line start, or a longer boundary that starts with this one.
    if ((at !== 0 && body[at - 1] !== 0x0a) || !endsDelimiter(body, from)) {
      if (misses && --misses.left <= 0) break;
      continue;
    }
    if (partStart !== -1) {
      let end = at;
      if (body[end - 1] === 0x0a) end--;
      if (body[end - 1] === 0x0d) end--;
      parts.push(body.subarray(partStart, Math.max(partStart, end)));
    }
    if (body[from] === 0x2d && body[from + 1] === 0x2d) return parts; // close delimiter
    const lineEnd = body.indexOf(0x0a, from);
    if (lineEnd === -1) return parts;
    partStart = lineEnd + 1;
  }
  if (partStart !== -1 && parts.length < MAX_MIME_PARTS) {
    parts.push(body.subarray(partStart)); // the input was cut off mid-part
  }
  return parts;
}

function readEntity(
  headers: MimeHeaders,
  body: Buffer,
  depth: number,
  budget: WalkState,
): FoundText {
  if (headers.attachment) return {};
  const type = headers.contentType;
  if (type === "text/plain" || type === "text/html") {
    const bytes = decodeTransfer(body, headers.encoding);
    // NUL-stripped before the caller's emptiness check: a NUL-only part is empty.
    const text = stripNul(decodeCharset(bytes, headers.params.get("charset")));
    if (type === "text/plain") return { plain: text };
    const atEnd = body.byteOffset + body.length >= budget.root.byteOffset + budget.root.length;
    return budget.cut && atEnd ? { html: text, htmlCut: true } : { html: text };
  }
  const boundary = headers.params.get("boundary");
  if (!type.startsWith("multipart/") || depth >= MAX_MIME_DEPTH) return {};
  if (!boundary || boundary.length > MAX_BOUNDARY_CHARS) return {};
  const found: FoundText = {};
  for (const part of splitMultipart(body, boundary)) {
    if (budget.parts <= 0) break;
    budget.parts--; // counted when visited, so siblings cannot starve a nested text part
    const { fields, content } = splitHeaders(part);
    const inner = readEntity(toMimeHeaders(fields), content, depth + 1, budget);
    // The first non-empty plain part and the first HTML part, in tree order: the
    // walk goes on past the plain part to its HTML sibling (multipart/alternative).
    if (found.plain === undefined && inner.plain?.trim()) found.plain = inner.plain;
    if (found.html === undefined && inner.html !== undefined) {
      found.html = inner.html;
      if (inner.htmlCut) found.htmlCut = true;
    }
    if (found.plain !== undefined && found.html !== undefined) break;
  }
  return found;
}

/** The decoded body of an IMAP message: its plain text, and its HTML part ("" when none). */
export interface ImapBody {
  text: string;
  html: string;
}

/**
 * Decoded plain text and HTML of an IMAP message body. The text is the raw text
 * when the body cannot be decoded; the HTML is then "". The HTML is stored as the
 * row's htmlBody and sanitized on read exactly like Gmail's (renderableEmailHtmlFor).
 */
export function decodeImapBody(
  headers: Buffer | undefined,
  text: Buffer | undefined,
  // False when `text` is a slice of BODY[TEXT] (a user-chosen host).
  opts: { complete?: boolean } = {},
): ImapBody {
  if (!text || text.length === 0) return { text: "", html: "" };
  if (!headers || headers.length === 0) return { text: rawText(text), html: "" };
  try {
    const top = toMimeHeaders(
      parseHeaderLines(headers.subarray(0, MAX_HEADER_BYTES).toString("latin1")),
    );
    const root = text.subarray(0, IMAP_DECODE_MAX_BYTES);
    // The top level is the message itself, never an attachment.
    const found = readEntity({ ...top, attachment: false }, root, 0, {
      parts: MAX_MIME_PARTS,
      root,
      cut: opts.complete === false || text.length > IMAP_DECODE_MAX_BYTES,
    });
    const source = found.html?.trim() ? (found.html as string) : "";
    // Cut markup is not stored: the reader then shows the plain body instead of a
    // page that stops mid-way (renderableEmailHtmlFor prefers htmlBody).
    const html = found.htmlCut ? "" : source;
    const plain = (found.plain ?? "").trim();
    if (plain) return { text: plain, html };
    if (!source) return { text: "", html: "" };
    return { text: stripNul(htmlToPlainText(capStored(source, MAX_HTML_TO_TEXT_CHARS))), html };
  } catch {
    return { text: rawText(text), html: "" };
  }
}

/** Decoded plain text of an IMAP message body; the raw text if it cannot be decoded. */
export function decodeImapText(headers: Buffer | undefined, text: Buffer | undefined): string {
  return decodeImapBody(headers, text).text;
}
