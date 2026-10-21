/**
 * The handle of a Klorn address: the local part of `<handle>@<domain>` (step E1a
 * of docs/providers/unified-platform-plan.md). User-chosen, immutable and never
 * issued again once its account is gone (L5): a handle that passes here once can
 * hold someone's mail forever, so the rules only ever get stricter.
 *
 * - 3 to 30 characters: `a-z` and `0-9`, with single `.`, `-` or `_` between
 *   them, starting and ending with a letter or digit. ASCII only, so no
 *   homoglyph can pass for another handle.
 * - No plus tags (L2: no aliases): `name+tag@` is an unknown address.
 * - Lowercased on input; the table stores only lowercase (a CHECK in the
 *   migration).
 * - The reserved list: mail roles, Klorn's own names, and the published
 *   addresses. E0's address inventory adds to it.
 */

export const KLORN_HANDLE_MIN_LENGTH = 3;
export const KLORN_HANDLE_MAX_LENGTH = 30;

const HANDLE_SHAPE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/** Never claimable. Every entry is lowercase and would otherwise be a valid handle. */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  // Mail roles (RFC 2142 and the usual system senders).
  "postmaster",
  "abuse",
  "hostmaster",
  "webmaster",
  "mailer-daemon",
  "noreply",
  "no-reply",
  "root",
  "admin",
  "security",
  // Klorn's own.
  "support",
  "help",
  "info",
  "billing",
  "privacy",
  "legal",
  "klorn",
  "team",
  // Published addresses, and the seeded demo user (auth.ts).
  "hello",
  "founders",
  "sales",
  "demo",
]);

export type HandleCheck =
  | { ok: true; handle: string }
  | { ok: false; reason: "length" | "characters" | "reserved" };

export function normalizeHandle(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isReservedHandle(handle: string): boolean {
  return RESERVED_HANDLES.has(normalizeHandle(handle));
}

/** Whether this value may be claimed as a handle, and its stored form. */
export function validateHandle(raw: unknown): HandleCheck {
  if (typeof raw !== "string") return { ok: false, reason: "length" };
  const handle = normalizeHandle(raw);
  if (handle.length < KLORN_HANDLE_MIN_LENGTH || handle.length > KLORN_HANDLE_MAX_LENGTH) {
    return { ok: false, reason: "length" };
  }
  if (!HANDLE_SHAPE.test(handle)) return { ok: false, reason: "characters" };
  if (RESERVED_HANDLES.has(handle)) return { ok: false, reason: "reserved" };
  return { ok: true, handle };
}
