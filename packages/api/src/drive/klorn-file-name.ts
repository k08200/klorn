/**
 * The name of a file or folder in the Klorn drive (step D3 of
 * docs/providers/unified-platform-plan.md). Metadata only: it is never part of
 * an object key (D1 mints the key), and a download carries it only as a cleaned
 * signed query value (storage/download-name.ts).
 *
 * Stricter than the shared row writer's `cleanDriveName`, because here the name
 * comes straight from the uploader and a Mac or web client may later save the
 * file under it: every control and format character is removed (the bidi
 * controls, which can disguise an extension, and the zero-width characters),
 * and the cap is the usual file-system name limit. A slash is kept: the name is
 * not a path, and the drive's folders are rows (D2).
 */

/** The longest name kept, in characters: the common file-system name limit. */
export const KLORN_FILE_NAME_MAX_CHARS = 255;

/**
 * C0 and C1 controls, and every format character (Cf): the bidi controls
 * (U+061C, U+200E-F, U+202A-E, U+2066-9), the zero-width space, joiners and
 * word joiner, the byte-order mark, the soft hyphen. Each is invisible or
 * reorders text, so it can make two names look alike or hide an extension.
 */
const UNSAFE_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

/** Names a file system reserves for "this folder" and "the parent folder". */
const RESERVED_NAMES = new Set([".", ".."]);

/** The cleaned name, or null when nothing usable is left. */
export function cleanKlornFileName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(UNSAFE_CHARACTERS, "").normalize("NFC").trim();
  const capped = [...cleaned].slice(0, KLORN_FILE_NAME_MAX_CHARS).join("").trimEnd();
  if (capped.length === 0 || RESERVED_NAMES.has(capped)) return null;
  return capped;
}
