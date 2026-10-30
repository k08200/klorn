// Same-origin navigation targets taken from a URL parameter or a server
// response. Import-free so packages/api can test it (the web package has no
// unit-test runner).

// One leading slash not followed by another ("//" is a protocol-relative URL),
// then only URL path/query characters. The allowlist leaves out the backslash
// (a URL parser reads "/\" as "//") and every whitespace or control character
// (the parser strips tabs and newlines, which can rebuild "//").
const SAFE_RELATIVE_PATH = /^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*$/;

/** A same-origin relative path, or null for anything a parser could read as another origin. */
export function safeRelativePath(value: unknown): string | null {
  return typeof value === "string" && SAFE_RELATIVE_PATH.test(value) ? value : null;
}

/** Where the sign-in page goes when `next` is absent, unsafe, or the sign-in page itself. */
const LOGIN_DEFAULT_NEXT = "/inbox";

/** The sign-in page's `?next=`: a strict same-origin path, never back to /login. */
export function loginNextPath(value: string | null): string {
  const path = safeRelativePath(value);
  if (path === null || path.startsWith("/login")) return LOGIN_DEFAULT_NEXT;
  return path;
}
