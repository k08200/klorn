/**
 * Stored attachment names and types for the non-Gmail producers (IMAP, Outlook).
 * Both are sender-controlled: the name is cleaned before it is stored, the type
 * must look like a MIME type or the caller falls back.
 */

import { cleanKlornFileName } from "../drive/klorn-file-name.js";

const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/** The name of an attached message that carries none. */
export const RFC822_FALLBACK_NAME = "attached-message.eml";

/**
 * A stored filename: the last path segment only ("../../x" -> "x"), cleaned like
 * a Klorn drive name (every control and format character removed, bidi overrides
 * included, NFC, at most 255 characters, never "." or ".."). "" when nothing is left.
 */
export function cleanAttachmentFilename(name: string): string {
  let base = "";
  for (const segment of name.split(/[/\\]/)) {
    if (segment.trim()) base = segment;
  }
  return cleanKlornFileName(base) ?? "";
}

/** A lower-cased `type/subtype`, or null when the value is not one. */
export function cleanMimeType(value: string | null | undefined): string | null {
  const lower = (value ?? "").trim().toLowerCase();
  return MIME_TYPE.test(lower) ? lower : null;
}
