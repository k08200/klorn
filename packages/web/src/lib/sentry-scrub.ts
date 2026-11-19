/**
 * What browser Sentry may send: nothing that names the user or their mail.
 *
 * Browser Sentry is off unless NEXT_PUBLIC_SENTRY_DSN is set at build time. If
 * it is turned on, an event must not carry an email address, a URL's query or
 * fragment (OAuth codes, search terms, message ids), a bearer token, the IP, or
 * text from a mail. The SDK's own `dataCollection` settings are applied too
 * (sentry.ts), but @sentry/browser 11 changed those defaults once already, so
 * these hooks are the guarantee: they run on every error event and breadcrumb,
 * whatever the SDK decides to collect.
 *
 * Every walk is bounded (depth and node budget) and every string pass is
 * linear: a hook runs on each captured error, and an event can hold anything.
 */

import type { Breadcrumb, ErrorEvent } from "@sentry/browser";

const MAX_DEPTH = 8;
const MAX_NODES = 2_000;
const MAX_STRING_LENGTH = 2_000;
export const REDACTED_ADDRESS = "[address]";
export const REDACTED_SECRET = "[secret]";
const TRUNCATED = "[truncated]";

/** Breadcrumb categories kept, with their URLs cut to the path. Console, DOM and the rest are dropped. */
const KEPT_BREADCRUMB_CATEGORIES = new Set(["fetch", "xhr", "navigation"]);

/** A whitespace- or quote-delimited token: matched once each, no backtracking. */
const TOKEN = /[^\s"'<>()[\]{},;]+/g;
const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+[^\s"']+/gi;
const ADDRESS_AT = /@|%40/i;
const JWT = /^eyJ[\w-]*\.[\w-]*\.[\w-]*$/;

/** Cut a URL (absolute or relative) at its query or fragment. */
export function stripUrlQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

function scrubToken(token: string): string {
  const at = token.search(ADDRESS_AT);
  if (at !== -1 && token.indexOf(".", at) !== -1) return REDACTED_ADDRESS;
  if (JWT.test(token)) return REDACTED_SECRET;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token) || token.startsWith("/")) return stripUrlQuery(token);
  return token;
}

/** Redact addresses, tokens and URL queries in free text. Long text is cut first. */
export function scrubText(text: string): string {
  const bounded = text.length > MAX_STRING_LENGTH ? `${text.slice(0, MAX_STRING_LENGTH)}…` : text;
  return bounded.replace(AUTH_SCHEME, `$1 ${REDACTED_SECRET}`).replace(TOKEN, scrubToken);
}

/** Every string in `value` scrubbed, at most MAX_DEPTH deep and MAX_NODES values in all. */
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
      if (Object.hasOwn(node, key))
        out[key] = walk((node as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}

/** The page request with only its path: no query, fragment, headers, cookies or body. */
function scrubRequest(request: ErrorEvent["request"]): ErrorEvent["request"] {
  if (!request) return undefined;
  return request.url ? { url: stripUrlQuery(request.url) } : undefined;
}

/** `beforeSend`: an error event with nothing that names the user or their mail. */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const { user: _user, request, breadcrumbs, ...rest } = event;
  const scrubbed = scrubDeep(rest) as ErrorEvent;
  const keptBreadcrumbs = (breadcrumbs ?? [])
    .map(scrubBreadcrumb)
    .filter((crumb): crumb is Breadcrumb => crumb !== null);
  return {
    ...scrubbed,
    ...(request ? { request: scrubRequest(request) } : {}),
    ...(breadcrumbs ? { breadcrumbs: keptBreadcrumbs } : {}),
  };
}

function scrubBreadcrumbData(data: Breadcrumb["data"]): Breadcrumb["data"] {
  if (!data) return undefined;
  const urlKeys = ["url", "from", "to"] as const;
  const withUrls = Object.fromEntries(
    Object.entries(data).map(([key, value]) =>
      urlKeys.includes(key as (typeof urlKeys)[number]) && typeof value === "string"
        ? [key, stripUrlQuery(value)]
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
