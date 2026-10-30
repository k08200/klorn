// Navigation targets taken from a URL parameter, a server response or a
// stored notification. Free of React and Next imports so packages/api can
// test it (the web package has no unit-test runner).

import { safeMeetingHref } from "./meeting-link";

// The path part: one leading slash, then only URL path characters. The
// allowlist leaves out the backslash (a URL parser reads "/\" as "//") and
// every whitespace or control character (the parser strips tabs and newlines,
// which can rebuild "//").
const SAFE_PATH = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/;
// The query: the same set plus "?" and the characters browsers leave
// unencoded in location.search (AuthGuard passes that into `next`). A query
// never changes the origin, so "//" and dots are harmless there.
const SAFE_QUERY = /^[A-Za-z0-9\-._~!$&'()*+,;=:@%/?[\]|{}^]*$/;
// "." / ".." segments, literal or percent-encoded: "/.//evil.com" and
// "/a/..//evil.com" normalise to a "//evil.com" pathname.
const DOT_SEGMENT = /(^|\/)(\.|%2e){1,2}(\/|$)/i;

/** A same-origin relative path, or null for anything a parser could read as another origin. */
export function safeRelativePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const queryStart = value.indexOf("?");
  const path = queryStart === -1 ? value : value.slice(0, queryStart);
  const query = queryStart === -1 ? "" : value.slice(queryStart + 1);
  if (!SAFE_PATH.test(path) || !SAFE_QUERY.test(query)) return null;
  if (path.includes("//") || DOT_SEGMENT.test(path)) return null;
  return value;
}

/** An absolute https URL with no userinfo (the meeting-link rule), or null. */
export function safeHttpsUrl(value: unknown): string | null {
  return typeof value === "string" ? safeMeetingHref(value) : null;
}

/** Where the sign-in page goes when `next` is absent, unsafe, or the sign-in page itself. */
const LOGIN_DEFAULT_NEXT = "/inbox";

/** The sign-in page's `?next=`: a strict same-origin path, never back to /login. */
export function loginNextPath(value: string | null): string {
  const path = safeRelativePath(value);
  if (path === null || path.startsWith("/login")) return LOGIN_DEFAULT_NEXT;
  return path;
}

const REGISTER_TAB = "/login?mode=register";

/** /early-access hands the visitor to the sign-up tab, keeping a strict same-origin `next`. */
export function registerRedirectTarget(next: string | null): string {
  const path = safeRelativePath(next);
  if (path === null || path.startsWith("/early-access")) return REGISTER_TAB;
  return `${REGISTER_TAB}&next=${encodeURIComponent(path)}`;
}
