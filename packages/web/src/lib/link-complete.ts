// The pure half of /link/complete: reading the parked-link handle from the
// fragment, and deciding what the completion response means. Import-free so
// packages/api can test it (the web package has no unit-test runner).

const HANDLE_FRAGMENT = /^#h=([0-9a-f]{64})$/;

// One leading slash not followed by another ("//" is a protocol-relative URL),
// then only URL path/query characters. The allowlist leaves out the backslash
// (a URL parser reads "/\" as "//") and every whitespace or control character
// (the parser strips tabs and newlines, which can rebuild "//").
const SAFE_RELATIVE_PATH = /^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*$/;

/** The handle in a `#h=<64 hex>` fragment, or null for anything else. */
export function readLinkHandle(hash: string): string | null {
  return HANDLE_FRAGMENT.exec(hash)?.[1] ?? null;
}

/**
 * A `next` the page may navigate to: a same-origin relative path only. The
 * server only ever sends paths from a fixed set; this keeps a response that
 * says otherwise from becoming an open redirect.
 */
export function safeNextPath(next: unknown): string | null {
  return typeof next === "string" && SAFE_RELATIVE_PATH.test(next) ? next : null;
}

export type LinkCompleteOutcome =
  | { kind: "redirect"; path: string }
  | { kind: "mismatch"; path: string | null }
  | { kind: "expired" }
  | { kind: "signIn" }
  | { kind: "failed" };

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
/** The body code of the API's "no such handle" 404; any other 404 is a failure. */
const LINK_EXPIRED = "LINK_EXPIRED";

function fieldOf(body: unknown, field: string): unknown {
  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)[field]
    : undefined;
}

function nextOf(body: unknown): string | null {
  return safeNextPath(fieldOf(body, "next"));
}

/** What POST /api/auth/link/complete's answer means for the page. */
export function linkCompleteOutcome(status: number, body: unknown): LinkCompleteOutcome {
  if (status === HTTP_OK) {
    const path = nextOf(body);
    return path ? { kind: "redirect", path } : { kind: "failed" };
  }
  if (status === HTTP_CONFLICT) return { kind: "mismatch", path: nextOf(body) };
  if (status === HTTP_NOT_FOUND) {
    return fieldOf(body, "code") === LINK_EXPIRED ? { kind: "expired" } : { kind: "failed" };
  }
  if (status === HTTP_UNAUTHORIZED) return { kind: "signIn" };
  return { kind: "failed" };
}

// ---------------------------------------------------------------------------
// Sign in, then come back. A native shell (Capacitor, Tauri) opens consent in
// the system browser, which usually has no Klorn session. The handle is kept
// in this tab's sessionStorage (never a URL or a log) while the user signs in,
// then /link/complete redeems it once. It lives no longer than the API keeps
// the parked code.

export const PENDING_LINK_STORAGE_KEY = "klorn-pending-link";
export const PENDING_LINK_MAX_AGE_MS = 5 * 60 * 1000;

/** The existing web sign-in, told to return here (login's own `?next=`). */
export const LINK_COMPLETE_SIGN_IN_HREF = `/login?next=${encodeURIComponent("/link/complete")}`;

const HANDLE_ONLY = /^[0-9a-f]{64}$/;

export type HandleStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** This tab's sessionStorage, or null outside a browser or when it is blocked. */
export function browserSessionStorage(): HandleStorage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function storePendingHandle(
  storage: HandleStorage | null,
  handle: string,
  now: number,
): boolean {
  if (!storage || !HANDLE_ONLY.test(handle)) return false;
  try {
    storage.setItem(PENDING_LINK_STORAGE_KEY, JSON.stringify({ h: handle, at: now }));
    return true;
  } catch {
    return false;
  }
}

export function clearPendingHandle(storage: HandleStorage | null): void {
  try {
    storage?.removeItem(PENDING_LINK_STORAGE_KEY);
  } catch {
    // Storage blocked: nothing was stored either.
  }
}

/** The stored handle when it is well formed and fresh; null otherwise. Never removes. */
function readFresh(storage: HandleStorage | null, now: number): string | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(PENDING_LINK_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const handle = fieldOf(parsed, "h");
    const at = fieldOf(parsed, "at");
    if (typeof handle !== "string" || !HANDLE_ONLY.test(handle) || typeof at !== "number") {
      return null;
    }
    const age = now - at;
    return age >= 0 && age <= PENDING_LINK_MAX_AGE_MS ? handle : null;
  } catch {
    return null;
  }
}

/** Is a fresh handle waiting for this tab to sign in? Leaves it stored. */
export function hasPendingHandle(storage: HandleStorage | null, now: number): boolean {
  const fresh = readFresh(storage, now) !== null;
  if (!fresh) clearPendingHandle(storage);
  return fresh;
}

/** Remove the stored handle and return it if it was fresh: it is redeemed at most once. */
export function takePendingHandle(storage: HandleStorage | null, now: number): string | null {
  const handle = readFresh(storage, now);
  clearPendingHandle(storage);
  return handle;
}
