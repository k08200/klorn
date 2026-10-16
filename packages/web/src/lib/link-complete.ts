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

function nextOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  return safeNextPath((body as { next?: unknown }).next);
}

/** What POST /api/auth/link/complete's answer means for the page. */
export function linkCompleteOutcome(status: number, body: unknown): LinkCompleteOutcome {
  if (status === HTTP_OK) {
    const path = nextOf(body);
    return path ? { kind: "redirect", path } : { kind: "failed" };
  }
  if (status === HTTP_CONFLICT) return { kind: "mismatch", path: nextOf(body) };
  if (status === HTTP_NOT_FOUND) return { kind: "expired" };
  if (status === HTTP_UNAUTHORIZED) return { kind: "signIn" };
  return { kind: "failed" };
}
