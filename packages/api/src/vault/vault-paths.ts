/**
 * Archive paths for the Klorn Vault export. Every path is built here from
 * server values (a YYYY-MM-DD key, a row id) plus a slug of the subject or the
 * sender's domain/address — the only untrusted parts — and then checked by
 * isVaultPath before the zip writer sees it (which checks again for zip-slip).
 *
 *   Klorn/_klorn.md
 *   Klorn/lanes/<LANE>.md
 *   Klorn/senders/<domain-or-address>.md
 *   Klorn/commitments/active.md, done.md
 *   Klorn/mail/YYYY/MM/YYYY-MM-DD-<slug>-<shortid>.md
 *
 * A segment holds letters, marks and numbers of any script plus `. _ @ + -`:
 * no separator, no drive colon, no wiki-link character (`[ ] | # ^`), no
 * control or format character, no space. It never starts with a dot (hidden
 * file, `..`) or ends with a dot (Windows strips it), never is a Windows
 * device name, and is capped in UTF-8 bytes (file systems cap names at 255).
 */

import { createHash } from "node:crypto";
import { orgDomainOf } from "../mail/public-mail-domains.js";

export const VAULT_ROOT = "Klorn";
export const VAULT_MAX_SEGMENT_BYTES = 120;
export const VAULT_MAX_PATH_BYTES = 240;
const SLUG_MAX_CHARS = 48;
const SLUG_MAX_BYTES = 64;
const SHORT_ID_LENGTHS = [8, 12, 16, 32] as const;
const HASH_SUFFIX_LENGTHS = [8, 16, 64] as const;
const MD = ".md";

const SEGMENT_CHARS = /^[\p{L}\p{M}\p{N}._@+-]+$/u;
const NOT_SLUG_CHAR = /[^\p{L}\p{M}\p{N}]+/gu;
const NOT_SENDER_CHAR = /[^\p{L}\p{M}\p{N}._@+-]+/gu;
const FORMAT_CHARS = /\p{Cf}/gu;
const DATE_KEY = /^(\d{4})-(\d{2})-\d{2}$/;
// CON, PRN, AUX, NUL, COM0-9, LPT0-9 (plus the superscript digits Windows
// also reserves), compared on the part before the first dot.
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/** Lowercase dash-joined words of any script; "untitled" when none are left. */
export function slugify(text: string, maxChars = SLUG_MAX_CHARS): string {
  const words = text
    .slice(0, 2_000)
    .normalize("NFKC")
    .replace(FORMAT_CHARS, "")
    .toLowerCase()
    .replace(NOT_SLUG_CHAR, "-")
    .replace(/^-+|-+$/g, "");
  const capped = capBytes(Array.from(words).slice(0, maxChars).join(""), SLUG_MAX_BYTES);
  return capped.replace(/-+$/, "") || "untitled";
}

/** Cut to at most `max` UTF-8 bytes without splitting a character. */
function capBytes(text: string, max: number): string {
  let out = "";
  let bytes = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > max) break;
    out += ch;
    bytes += size;
  }
  return out;
}

/** The path checks every archive path passes. */
export function isVaultPath(path: string): boolean {
  if (!path.endsWith(MD) || Buffer.byteLength(path) > VAULT_MAX_PATH_BYTES) return false;
  const segments = path.split("/");
  if (segments[0] !== VAULT_ROOT || segments.length < 2) return false;
  return segments.every(isSafeSegment);
}

function isSafeSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    Buffer.byteLength(segment) <= VAULT_MAX_SEGMENT_BYTES &&
    SEGMENT_CHARS.test(segment) &&
    !segment.startsWith(".") &&
    !segment.endsWith(".") &&
    !WINDOWS_DEVICE.test(segment.split(".")[0] ?? "")
  );
}

/**
 * Hands out each path once. Mail paths lengthen their id on a clash; sender
 * paths are keyed, so one sender key always maps to one path and two keys
 * that sanitize alike get `-2`, `-3`, ...
 */
export class PathRegistry {
  readonly #used = new Set<string>();
  readonly #byKey = new Map<string, string>();

  claim(path: string): boolean {
    if (this.#used.has(path.toLowerCase())) return false;
    this.#used.add(path.toLowerCase());
    return true;
  }

  keyed(key: string): string | undefined {
    return this.#byKey.get(key);
  }

  remember(key: string, path: string): void {
    this.#byKey.set(key, path);
  }
}

export interface MailPathInput {
  /** The mail's local date, YYYY-MM-DD, in the user's time zone. */
  dateKey: string;
  subject: string;
  /** EmailMessage.id: only its hex digits are used. */
  id: string;
}

/** Klorn/mail/YYYY/MM/YYYY-MM-DD-<slug>-<shortid>.md, unique in `paths`. */
export function mailNotePath(input: MailPathInput, paths: PathRegistry): string {
  const date = DATE_KEY.exec(input.dateKey);
  if (!date) throw new Error("mailNotePath: date key is not YYYY-MM-DD");
  const hex = input.id.toLowerCase().replace(/[^0-9a-f]/g, "") || "0";
  const slug = slugify(input.subject);
  for (const length of SHORT_ID_LENGTHS) {
    const name = `${input.dateKey}-${slug}-${hex.slice(0, length)}${MD}`;
    const path = `${VAULT_ROOT}/mail/${date[1]}/${date[2]}/${name}`;
    if (!isVaultPath(path)) throw new Error("mailNotePath: unsafe path");
    if (paths.claim(path)) return path;
    if (length >= hex.length) break;
  }
  throw new Error("mailNotePath: no free path for this mail");
}

/** The sender a mail is filed under: the organisation's domain, else the address. */
export function senderKeyOf(address: string | null | undefined): string {
  const addr = (address ?? "").trim().toLowerCase();
  if (!addr) return "unknown";
  return orgDomainOf(addr) ?? addr;
}

/**
 * Klorn/senders/<key>.md: one path per key, unique in `paths`. Two keys that
 * sanitize alike (or differ only in case) are told apart by a hash of the key,
 * so the suffix is stable across exports and never runs out.
 */
export function senderNotePath(key: string, paths: PathRegistry): string {
  const known = paths.keyed(key);
  if (known) return known;
  const base = senderSegment(key);
  const hash = createHash("sha256").update(key).digest("hex");
  const names = [
    base,
    ...HASH_SUFFIX_LENGTHS.map(
      (n) => `${capBytes(base, VAULT_MAX_SEGMENT_BYTES - MD.length - n - 1)}-${hash.slice(0, n)}`,
    ),
  ];
  for (const name of names) {
    const path = `${VAULT_ROOT}/senders/${name}${MD}`;
    if (!isVaultPath(path)) throw new Error("senderNotePath: unsafe path");
    if (paths.claim(path)) {
      paths.remember(key, path);
      return path;
    }
  }
  throw new Error("senderNotePath: no free path for this sender");
}

function senderSegment(key: string): string {
  const cleaned = key
    .slice(0, 1_000)
    .normalize("NFKC")
    .replace(FORMAT_CHARS, "")
    .toLowerCase()
    .replace(NOT_SENDER_CHAR, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.-]+|[.-]+$/g, "")
    // A key ending in ".md" (Moldova's TLD) would make "corp.md.md", whose
    // link [[…/corp.md]] Obsidian reads as the file "corp.md".
    .replace(/\.md$/, "_md");
  // One byte spare for the device-name prefix below.
  const capped = capBytes(cleaned, VAULT_MAX_SEGMENT_BYTES - MD.length - 1).replace(/[.-]+$/, "");
  const segment = capped || "unknown";
  return WINDOWS_DEVICE.test(segment.split(".")[0] ?? "") ? `_${segment}` : segment;
}
