/**
 * IMAP attachments: the parts of a message that Gmail would list as attachments,
 * read from the BODY[TEXT] the poll already fetches, in Gmail's attachment model
 * (RawEmailAttachment, keyed by partKey).
 *
 * - The tree is walked with imap-body.ts's bounded linear MIME reader (forward
 *   scans only; depth, parts visited, header bytes and boundary length capped).
 *   No full MIME parser runs on sender input (#1466/#1467/#1468).
 * - partKey is the IMAP section number ("2", "1.2"), immutable per message, so
 *   a re-poll upserts the same rows, and BODY[<section>] fetches the bytes again
 *   on download. The handle (gmailAttachmentId) is the same section.
 * - The keep rule is Gmail's (gmail-fetch.ts extractAttachmentsFromPayload): a
 *   part with a filename, or a filename-less image/* with a Content-ID (inline
 *   cid: image, named `inline-<cid>`). A message/rfc822 part is one `.eml`
 *   attachment; its inner parts are not walked.
 * - Text is extracted exactly as for Gmail: only isReadableEmailAttachment
 *   parts, never inline-only images, through the isolated worker
 *   (attachment-extract-isolated.ts: time, heap and queue limits). A failure
 *   keeps the row without text. No bytes are stored.
 */

import { extractAttachmentContentIsolated } from "./attachment-extract-isolated.js";
import {
  cleanAttachmentFilename,
  cleanMimeType,
  RFC822_FALLBACK_NAME,
} from "./attachment-names.js";
import { isReadableEmailAttachment } from "./email-attachment-text.js";
import type { RawEmailAttachment } from "./email-attachments.js";
import { decodeEncodedWords } from "./encoded-words.js";
import {
  decodeCharset,
  decodeTransfer,
  MAX_BOUNDARY_CHARS,
  MAX_HEADER_BYTES,
  MAX_MIME_DEPTH,
  MAX_MIME_PARTS,
  parseHeaderLines,
  parseParams,
  splitHeaders,
  splitMultipart,
} from "./imap-body.js";

/** A fixed host returns the whole TEXT; past this the scan treats it as cut. */
export const MAX_ATTACHMENT_SCAN_BYTES = 32 * 1024 * 1024;
/**
 * Delimiter look-alikes one walk may skip (splitMultipart). Each costs a native
 * search; without a cap a body of `--<boundary>x` lines, nested eight deep, held
 * the event loop for ~2 s at 20 MiB (security review, 2026-11-12).
 */
const MAX_DELIMITER_MISSES = 10_000;
const MAX_CONTENT_ID_CHARS = 255;
/** RFC 2231 `name*0`, `name*1`, …: segments read per parameter. */
const MAX_PARAM_CONTINUATIONS = 64;
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional reject filter
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export interface ImapAttachmentPart {
  /** IMAP section number: BODY[<section>] is this part's content. */
  section: string;
  filename: string;
  mimeType: string;
  contentId: string | null;
  /** A filename-less cid: image: kept for rendering, never extracted. */
  inlineOnly: boolean;
  /**
   * The decoded bytes, or null when the fetched slice cut the part. Decoding is
   * left to the caller (imapRawAttachments), after it knows the message needs it.
   */
  decode(): Buffer | null;
}

interface Walk {
  root: Buffer;
  complete: boolean;
  budget: { parts: number };
  misses: { left: number };
  out: ImapAttachmentPart[];
}

/**
 * The attachment parts of one message. `complete` says whether `text` is the
 * whole BODY[TEXT] (a fixed host) or a slice of it (a user-chosen host): in a
 * slice, the part the cut lands in has no size and no bytes. Never throws.
 */
export function collectImapAttachmentParts(
  headers: Buffer | undefined,
  text: Buffer | undefined,
  opts: { complete: boolean },
): ImapAttachmentPart[] {
  if (!headers?.length || !text?.length) return [];
  try {
    const root = text.subarray(0, MAX_ATTACHMENT_SCAN_BYTES);
    const walk: Walk = {
      root,
      complete: opts.complete && text.length <= MAX_ATTACHMENT_SCAN_BYTES,
      budget: { parts: MAX_MIME_PARTS },
      misses: { left: MAX_DELIMITER_MISSES },
      out: [],
    };
    const fields = parseHeaderLines(headers.subarray(0, MAX_HEADER_BYTES).toString("latin1"));
    if (contentTypeOf(fields).main.startsWith("multipart/")) {
      visitMultipart(fields, root, "", 0, walk);
    } else {
      visitLeaf(fields, root, "1", walk); // a single-part message's body is section 1
    }
    return walk.out;
  } catch {
    return [];
  }
}

function contentTypeOf(fields: Map<string, string>) {
  return parseParams(fields.get("content-type") ?? "text/plain");
}

function visitMultipart(
  fields: Map<string, string>,
  body: Buffer,
  prefix: string,
  depth: number,
  walk: Walk,
): void {
  if (depth >= MAX_MIME_DEPTH) return;
  const boundary = contentTypeOf(fields).params.get("boundary");
  if (!boundary || boundary.length > MAX_BOUNDARY_CHARS) return;
  const parts = splitMultipart(body, boundary, walk.misses);
  for (let i = 0; i < parts.length; i++) {
    if (walk.budget.parts <= 0) return;
    walk.budget.parts--;
    const section = prefix ? `${prefix}.${i + 1}` : String(i + 1);
    const { fields: child, content } = splitHeaders(parts[i] as Buffer);
    if (contentTypeOf(child).main.startsWith("multipart/")) {
      visitMultipart(child, content, section, depth + 1, walk);
    } else {
      visitLeaf(child, content, section, walk);
    }
  }
}

function visitLeaf(
  fields: Map<string, string>,
  content: Buffer,
  section: string,
  walk: Walk,
): void {
  const type = contentTypeOf(fields);
  const disposition = parseParams(fields.get("content-disposition") ?? "");
  const mimeType = cleanMimeType(type.main) ?? "application/octet-stream";
  const contentId = cleanContentId(fields.get("content-id"));
  const named = cleanAttachmentFilename(
    paramText(disposition.params, "filename") ?? paramText(type.params, "name") ?? "",
  );
  const inlineOnly = !named && contentId !== null;
  // Gmail's rule: a filename-less cid part is kept only to resolve src="cid:…".
  if (inlineOnly && !mimeType.startsWith("image/")) return;
  const filename =
    named ||
    (contentId ? cleanAttachmentFilename(`inline-${contentId}`) : "") ||
    (mimeType === "message/rfc822" ? RFC822_FALLBACK_NAME : "");
  if (!filename) return;

  const encoding = (fields.get("content-transfer-encoding") ?? "").trim().toLowerCase();
  const cut = !walk.complete && endsAtCut(content, walk.root);
  walk.out.push({
    section,
    filename,
    mimeType,
    contentId,
    inlineOnly,
    decode: () => (cut ? null : decodeTransfer(content, encoding)),
  });
}

/** The slice ended inside this part (both views share one buffer). */
function endsAtCut(content: Buffer, root: Buffer): boolean {
  return content.byteOffset + content.length >= root.byteOffset + root.length;
}

/** Gmail's Content-ID rule (gmail-fetch.ts extractContentId), plus a length cap. */
function cleanContentId(raw: string | undefined): string | null {
  if (!raw) return null;
  const stripped = raw.trim().replace(/^</, "").replace(/>$/, "").trim();
  if (!stripped || stripped.length > MAX_CONTENT_ID_CHARS || CONTROL_CHARS.test(stripped)) {
    return null;
  }
  return stripped;
}

/**
 * A MIME parameter as text: RFC 2231 extended (`name*=charset''%XX`), RFC 2231
 * continuations (`name*0*`, `name*1`, …), else the plain value with RFC 2047
 * encoded-words decoded. Null when absent.
 */
function paramText(params: Map<string, string>, name: string): string | null {
  const extended = params.get(`${name}*`);
  if (extended !== undefined) {
    const { charset, value } = splitCharset(extended);
    return decodeCharset(percentDecode(value), charset || "utf-8");
  }
  if (params.has(`${name}*0*`) || params.has(`${name}*0`)) return continuations(params, name);
  const plain = params.get(name);
  return plain === undefined ? null : decodeEncodedWords(rawHeaderText(plain));
}

function continuations(params: Map<string, string>, name: string): string {
  let charset = "";
  const chunks: Buffer[] = [];
  for (let i = 0; i < MAX_PARAM_CONTINUATIONS; i++) {
    const encoded = params.get(`${name}*${i}*`);
    const plain = params.get(`${name}*${i}`);
    if (encoded === undefined && plain === undefined) break;
    if (encoded === undefined) {
      chunks.push(Buffer.from(plain as string, "latin1"));
      continue;
    }
    let value = encoded;
    if (i === 0) {
      const split = splitCharset(encoded);
      charset = split.charset;
      value = split.value;
    }
    chunks.push(percentDecode(value));
  }
  return decodeCharset(Buffer.concat(chunks), charset || "utf-8");
}

/** `charset'language'value` → its charset and value; no quotes → the whole value. */
function splitCharset(raw: string): { charset: string; value: string } {
  const first = raw.indexOf("'");
  const second = first === -1 ? -1 : raw.indexOf("'", first + 1);
  if (second === -1) return { charset: "", value: raw };
  return { charset: raw.slice(0, first).trim(), value: raw.slice(second + 1) };
}

function hexDigit(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x37;
  if (code >= 0x61 && code <= 0x66) return code - 0x57;
  return -1;
}

function percentDecode(value: string): Buffer {
  const out = Buffer.alloc(value.length);
  let j = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const high = code === 0x25 ? hexDigit(value.charCodeAt(i + 1)) : -1;
    const low = high === -1 ? -1 : hexDigit(value.charCodeAt(i + 2));
    if (low !== -1) {
      out[j++] = high * 16 + low;
      i += 2;
    } else {
      out[j++] = code & 0xff;
    }
  }
  return out.subarray(0, j);
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** Headers are read as latin1; raw 8-bit UTF-8 in a quoted value is decoded as UTF-8. */
function rawHeaderText(value: string): string {
  if (!/[\u0080-ÿ]/.test(value)) return value;
  try {
    return strictUtf8.decode(Buffer.from(value, "latin1"));
  } catch {
    return value;
  }
}

async function readableText(part: ImapAttachmentPart, bytes: Buffer): Promise<string | null> {
  // Inline-only images are never extracted (Gmail: a sender-controlled LLM cost).
  if (part.inlineOnly) return null;
  if (!isReadableEmailAttachment(part.filename, part.mimeType, bytes.length)) return null;
  try {
    return (await extractAttachmentContentIsolated(bytes, part.filename, part.mimeType)).text;
  } catch {
    return null; // Gmail's contract: the row stays, without text
  }
}

/**
 * The parts as RawEmailAttachment rows: size is the decoded length (null for a
 * part the slice cut), readable ones carry their extracted text. Each part is
 * decoded (natively) only here, one at a time.
 */
export async function imapRawAttachments(
  parts: ImapAttachmentPart[],
): Promise<RawEmailAttachment[]> {
  const rows: RawEmailAttachment[] = [];
  for (const part of parts) {
    const bytes = part.decode();
    rows.push({
      gmailAttachmentId: part.section,
      partKey: part.section,
      filename: part.filename,
      mimeType: part.mimeType,
      size: bytes ? bytes.length : null,
      contentId: part.contentId,
      contentText: bytes ? await readableText(part, bytes) : null,
    });
  }
  return rows;
}
