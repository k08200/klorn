/**
 * What browser Sentry may send: nothing that names the user or their mail.
 *
 * Browser Sentry is off unless NEXT_PUBLIC_SENTRY_DSN is set at build time. If
 * it is turned on, an event must not carry an email address, a URL's query or
 * fragment (OAuth codes, search terms), credentials in a URL, a bearer token,
 * JWT, API key or `token=` value, the IP, or text from a mail. The SDK's own
 * `dataCollection` settings are applied too (sentry-options.ts), but @sentry/browser 11
 * changed those defaults once already, so these hooks are the guarantee: they
 * run on every error event and breadcrumb, whatever the SDK decides to collect.
 *
 * Kept on purpose: URL paths, which carry opaque Klorn and Gmail ids
 * (`/email/<id>`) and never an address or token; the same ids already travel
 * as `captureClientError` extras.
 *
 * Every walk is bounded (depth and node budget) and every string pass is a
 * linear regex over a bounded string: a hook runs on each captured error, and
 * an event can hold anything.
 */

import type { Breadcrumb, ErrorEvent } from "@sentry/browser";

const MAX_DEPTH = 8;
const MAX_NODES = 2_000;
const MAX_SCANNED_LENGTH = 20_000;
const MAX_STRING_LENGTH = 2_000;
export const REDACTED_ADDRESS = "[address]";
export const REDACTED_SECRET = "[secret]";
const TRUNCATED = "[truncated]";

/** Breadcrumb categories kept, with their URLs cut to the path. Console, DOM and the rest are dropped. */
const KEPT_BREADCRUMB_CATEGORIES = new Set(["fetch", "xhr", "navigation"]);
/** Event fields the SDK builds itself: never user text, and an address rule must not mangle them. */
const STRUCTURAL_FIELDS = new Set(["event_id", "timestamp", "platform", "level", "sdk", "release"]);

/** A chunk between whitespace, double quotes and angle brackets: a URL stays whole. */
const CHUNK = /[^\s"<>`]+/g;
/** A finer token, for addresses inside a chunk: a URL path splits at `/`, so only the address segment goes. */
const TOKEN = /[^\s"<>`()[\]{},/]+/g;
/** `@` and the encodings a URL, HTML or MIME text uses for it. */
const AT_SIGN = /@|%(?:25)*40|&#0*64;|&#x0*40;|&commat;|＠/gi;
const HOST_CHARS = /^[\p{L}\p{N}.-]+/u;
const TOP_LEVEL_DOMAIN = /^\p{L}{2,}$/u;
/** A credential after the scheme: 8+ token characters with a digit or `+/=` (not "Basic validation"). */
const AUTH_SCHEME = /\b(Bearer|Basic)\s+(?=[A-Za-z0-9._~+/=-]*[0-9+/=])[A-Za-z0-9._~+/=-]{8,}/g;
const SECRET_VALUE =
  /\b((?:access_|refresh_|id_)?token|secret|password|passwd|authorization|cookie|session_?id|api[_-]?key)(\s*[=:]\s*)[^\s&"',;]{8,}/gi;
/** An OAuth `code=` outside a URL (inside one, the query is cut). Not `code: ECONNRESET`. */
const OAUTH_CODE = /\b(code)(=)[^\s&"',;]{8,}/g;
const KNOWN_SECRET = /eyJ[\w-]+\.[\w-]+\.[\w-]+|sk-(?:ant|or|proj)-[\w-]{8,}|AIza[\w-]{20,}/g;

/** Cut a URL (absolute or relative) at its query or fragment. */
export function stripUrlQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/** A URL with no query, fragment or `user:password@`, its path scrubbed like any text. */
export function scrubUrl(url: string): string {
  const withoutQuery = stripUrlQuery(url).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
  return scrubText(withoutQuery);
}

/** A host: two or more labels ending in an alphabetic top-level domain (not `1.2.3`, not `localhost`). */
function startsWithHost(text: string): boolean {
  const host = (HOST_CHARS.exec(text)?.[0] ?? "").replace(/\.+$/, "");
  const labels = host.split(".");
  return (
    labels.length >= 2 &&
    labels.every((label) => label.length > 0) &&
    TOP_LEVEL_DOMAIN.test(labels[labels.length - 1])
  );
}

/**
 * Does this token hold an address: something, an `@` (or an encoding of it),
 * then a host? Not `@mention`, not `@scope` of `node_modules/@scope/pkg`, not `pkg@1.2.3`.
 */
function holdsAddress(token: string): boolean {
  for (const at of token.matchAll(AT_SIGN)) {
    const index = at.index ?? 0;
    if (index > 0 && startsWithHost(token.slice(index + at[0].length))) return true;
  }
  return false;
}

/** A chunk with a path, then a query or fragment (`https://h/p?q`, `/p#f`, `GET:/p?q`, `host/p?q`), cut at it. */
function cutChunkQuery(chunk: string): string {
  const query = chunk.search(/[?#]/);
  if (query === -1 || chunk.lastIndexOf("/", query) === -1) return chunk;
  return chunk.slice(0, query);
}

function scrubToken(token: string): string {
  return holdsAddress(token) ? REDACTED_ADDRESS : token;
}

/** Text no longer than `max`, cut at the last whitespace so no token is split. */
function boundAtWhitespace(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(" ", max);
  return `${cut > 0 ? text.slice(0, cut) : ""} ${TRUNCATED}`;
}

/** Redact addresses, secrets and URL queries in free text, then cut it. */
export function scrubText(text: string): string {
  const scanned = boundAtWhitespace(text, MAX_SCANNED_LENGTH);
  const scrubbed = scanned
    .replace(CHUNK, cutChunkQuery)
    .replace(AUTH_SCHEME, `$1 ${REDACTED_SECRET}`)
    .replace(SECRET_VALUE, `$1$2${REDACTED_SECRET}`)
    .replace(OAUTH_CODE, `$1$2${REDACTED_SECRET}`)
    .replace(KNOWN_SECRET, REDACTED_SECRET)
    .replace(TOKEN, scrubToken);
  return scrubbed.length > MAX_STRING_LENGTH
    ? `${scrubbed.slice(0, MAX_STRING_LENGTH)}…`
    : scrubbed;
}

/** Every key and string in `value` scrubbed, at most MAX_DEPTH deep and MAX_NODES values in all. */
export function scrubDeep(value: unknown): unknown {
  let budget = MAX_NODES;
  const walk = (node: unknown, depth: number): unknown => {
    budget -= 1;
    if (budget < 0) return TRUNCATED;
    if (typeof node === "string") return scrubText(node);
    if (node === null || typeof node !== "object") return node;
    if (depth >= MAX_DEPTH || ArrayBuffer.isView(node) || node instanceof ArrayBuffer) {
      return TRUNCATED;
    }
    // Never enumerate past the budget: an array or object can be huge.
    if (Array.isArray(node)) {
      return node.slice(0, Math.max(budget, 0) + 1).map((item) => walk(item, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const key in node) {
      if (budget < 0) break;
      if (!Object.hasOwn(node, key)) continue;
      // defineProperty, so an own `__proto__` key stays a key.
      Object.defineProperty(out, scrubText(key), {
        value: walk((node as Record<string, unknown>)[key], depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  };
  return walk(value, 0);
}

/** The page request with only its path: no query, fragment, headers, cookies or body. */
function scrubRequest(request: ErrorEvent["request"]): ErrorEvent["request"] {
  if (!request) return undefined;
  return request.url ? { url: scrubUrl(request.url) } : undefined;
}

/** `beforeSend`: an error event with nothing that names the user or their mail. */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const { user: _user, request, breadcrumbs, ...rest } = event;
  // Each top-level field gets its own budget, so a huge extra cannot crowd out the exception.
  const scrubbed = Object.fromEntries(
    Object.entries(rest).map(([key, value]) => [
      key,
      STRUCTURAL_FIELDS.has(key) ? value : scrubDeep(value),
    ]),
  ) as unknown as typeof rest;
  const keptBreadcrumbs = (breadcrumbs ?? [])
    .map(scrubBreadcrumb)
    .filter((crumb): crumb is Breadcrumb => crumb !== null);
  return {
    ...scrubbed,
    ...(request ? { request: scrubRequest(request) } : {}),
    ...(breadcrumbs ? { breadcrumbs: keptBreadcrumbs } : {}),
  };
}

const BREADCRUMB_URL_KEYS = new Set(["url", "from", "to"]);

function scrubBreadcrumbData(data: Breadcrumb["data"]): Breadcrumb["data"] {
  if (!data) return undefined;
  const withUrls = Object.fromEntries(
    Object.entries(data).map(([key, value]) =>
      BREADCRUMB_URL_KEYS.has(key) && typeof value === "string"
        ? [key, scrubUrl(value)]
        : [key, value],
    ),
  );
  return scrubDeep(withUrls) as Breadcrumb["data"];
}

/** `beforeBreadcrumb`: only requests and navigations, with their URLs cut to the path. */
export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb | null {
  if (!crumb.category || !KEPT_BREADCRUMB_CATEGORIES.has(crumb.category)) return null;
  return {
    ...crumb,
    ...(crumb.message !== undefined ? { message: scrubText(crumb.message) } : {}),
    ...(crumb.data !== undefined ? { data: scrubBreadcrumbData(crumb.data) } : {}),
  };
}
