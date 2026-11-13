// Dynamic route ids on the static export (docs/deploy/cloudflare-pages.md).
//
// The Next server renders `/email/<id>` per request, so the router's param IS
// the id. The static export cannot: it prerenders one shell per dynamic route
// under the placeholder id below, and Cloudflare rewrites every
// `/email/<id>` to that shell (public/_redirects). On the shell the router's
// param is the placeholder, so the page reads the real id from the URL.
// Free of React and Next imports so packages/api can test it (the web package
// has no unit-test runner).

/** The id each dynamic route's static shell is prerendered under. Never a real id. */
export const STATIC_SHELL_PARAM = "_";

// One path segment: URL path characters only, no "/" and no whitespace,
// backslash, "?" or "#". Kept percent-encoded, as the router's own params are:
// decoding would turn "%2F" into a real slash inside `/api/email/${id}`.
const SEGMENT = /^[A-Za-z0-9\-._~!$&'()*+,;=:@%]+$/;
// "." and ".." — literal or percent-encoded — would climb out of the API path.
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

/** The single raw segment right after `prefix` ("/email/"), or null when the path is anything else. */
export function segmentAfter(pathname: string | null | undefined, prefix: string): string | null {
  if (typeof pathname !== "string" || !pathname.startsWith(prefix)) return null;
  const segment = pathname.slice(prefix.length);
  if (!SEGMENT.test(segment) || DOT_SEGMENT.test(segment)) return null;
  return segment;
}

/**
 * The route's id: the router's param when it is a real one (the Next server
 * build), otherwise the URL's segment. The URL is only read once `hydrated`, so
 * the shell prerendered at build time and the first client render agree.
 */
export function resolveRouteParam(
  routerValue: unknown,
  pathname: string | null | undefined,
  prefix: string,
  hydrated: boolean,
): string | undefined {
  if (typeof routerValue === "string" && routerValue !== STATIC_SHELL_PARAM) return routerValue;
  if (!hydrated) return undefined;
  return segmentAfter(pathname, prefix) ?? undefined;
}
