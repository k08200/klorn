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
 * - The reserved list (mail roles, the CA/Browser Forum validation names,
 *   Klorn's own names, published addresses, vendors), compared by
 *   handleSkeleton so `post.master` or `adm1n` is refused too, and nothing that
 *   reads as `klorn`. E0's address inventory adds to it.
 * - The database adds what no writer can skip: the shape, lowercase only, no
 *   two handles that differ only in separators, and no rename, delete or
 *   reassignment (migration 20261021010100_klorn_mailbox_schema).
 */

export const KLORN_HANDLE_MIN_LENGTH = 3;
export const KLORN_HANDLE_MAX_LENGTH = 30;

const HANDLE_SHAPE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/**
 * Never claimable, nor anything that reads the same (handleSkeleton). Every entry
 * is lowercase and would otherwise be a valid handle.
 */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  // Mail roles: RFC 2142 and the usual system senders.
  "postmaster",
  "abuse",
  "hostmaster",
  "webmaster",
  "mailer-daemon",
  "noreply",
  "no-reply",
  "root",
  "noc",
  "marketing",
  "www",
  "ftp",
  "news",
  "usenet",
  "uucp",
  "listmaster",
  "bounce",
  "bounces",
  "unsubscribe",
  // The CA/Browser Forum's domain-validation local parts: whoever holds one of
  // these can receive a certificate approval for the whole domain.
  "admin",
  "administrator",
  // Klorn's own, and names a reader trusts.
  "security",
  "support",
  "help",
  "info",
  "billing",
  "privacy",
  "legal",
  "team",
  "official",
  "staff",
  "owner",
  "ceo",
  "founder",
  "service",
  "services",
  "system",
  "contact",
  "press",
  "careers",
  "jobs",
  "compliance",
  "dpo",
  "trust",
  "safety",
  "status",
  "verify",
  "account",
  "accounts",
  "login",
  "payments",
  "invoices",
  "refunds",
  "notifications",
  "notify",
  "alerts",
  "feedback",
  "api",
  "app",
  "mail",
  "email",
  "test",
  "null",
  // Published addresses, and the seeded demo user (auth.ts).
  "hello",
  "founders",
  "sales",
  "demo",
  // Vendors whose mail a reader would trust from this domain.
  "google",
  "apple",
  "microsoft",
  "github",
  "openai",
  "stripe",
  "paddle",
  "resend",
]);

/**
 * What a reader would take for the same handle: the separators dropped and the
 * usual look-alikes folded (`rn`→`m`, `vv`→`w`, `0`→`o`, `1` and `i`→`l`). Used
 * only to keep reserved names and Klorn's name from being imitated; the
 * database separately refuses two handles that differ only in separators.
 */
export function handleSkeleton(handle: string): string {
  return normalizeHandle(handle)
    .replace(/[._-]/g, "")
    .replace(/rn/g, "m")
    .replace(/vv/g, "w")
    .replace(/0/g, "o")
    .replace(/[1i]/g, "l");
}

const RESERVED_SKELETONS: ReadonlySet<string> = new Set(
  [...RESERVED_HANDLES].map((handle) => handleSkeleton(handle)),
);
/** No handle may read as Klorn's own name anywhere in it. */
const BRAND_SKELETON = handleSkeleton("klorn");

export type HandleCheck =
  | { ok: true; handle: string }
  | { ok: false; reason: "length" | "characters" | "reserved" };

export function normalizeHandle(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Reserved, a look-alike of a reserved name, or reading as Klorn. */
export function isReservedHandle(handle: string): boolean {
  const skeleton = handleSkeleton(handle);
  return RESERVED_SKELETONS.has(skeleton) || skeleton.includes(BRAND_SKELETON);
}

/**
 * The shape alone (length and characters), for an already-lowercased handle.
 * Inbound mail is matched by this and the database row, never by the reserved
 * list, so a later addition to the list cannot stop delivery to an existing owner.
 */
export function isWellFormedHandle(handle: string): boolean {
  return (
    handle.length >= KLORN_HANDLE_MIN_LENGTH &&
    handle.length <= KLORN_HANDLE_MAX_LENGTH &&
    HANDLE_SHAPE.test(handle)
  );
}

/** Whether this value may be claimed as a handle, and its stored form. */
export function validateHandle(raw: unknown): HandleCheck {
  if (typeof raw !== "string") return { ok: false, reason: "length" };
  const handle = normalizeHandle(raw);
  if (handle.length < KLORN_HANDLE_MIN_LENGTH || handle.length > KLORN_HANDLE_MAX_LENGTH) {
    return { ok: false, reason: "length" };
  }
  if (!HANDLE_SHAPE.test(handle)) return { ok: false, reason: "characters" };
  if (isReservedHandle(handle)) return { ok: false, reason: "reserved" };
  return { ok: true, handle };
}
