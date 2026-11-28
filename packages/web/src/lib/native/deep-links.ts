// The two deep links the Capacitor shell honours, and the account-link relay
// query. Ported from apps/mobile/src/auth/oauth.ts and platform/link-relay.ts.
// Only capacitor.ts is imported (no plugin), so packages/api can test it.

import { isNativePlatform } from "./capacitor";

/** The registered app scheme (ai.klorn.app), set only for shell builds. */
export const NATIVE_OAUTH_SCHEME: string | undefined = process.env.NEXT_PUBLIC_NATIVE_OAUTH_SCHEME;

const CODE = /^[A-Za-z0-9_-]{8,256}$/;
const HANDLE = /^[0-9a-f]{64}$/;

function deepLinkParam(url: string, scheme: string, target: string, param: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${scheme}:`) return null;
  const host = parsed.host || parsed.pathname.replace(/^\/+/, "");
  if (host !== target) return null;
  return parsed.searchParams.get(param);
}

/** The one-time sign-in code from `<scheme>://oauth-callback?code=…`, or null. */
export function parseOAuthCallback(url: string, scheme: string): string | null {
  const code = deepLinkParam(url, scheme, "oauth-callback", "code");
  return code && CODE.test(code) ? code : null;
}

/** The parked link handle from `<scheme>://link-complete?h=…`, or null. */
export function parseLinkComplete(url: string, scheme: string): string | null {
  const handle = deepLinkParam(url, scheme, "link-complete", "h");
  return handle && HANDLE.test(handle) ? handle : null;
}

/**
 * `?appScheme=<scheme>` for an account-link start inside the shell, so the
 * callback deep-links the parked handle back to the app (routes/link-handoff.ts)
 * instead of finishing in the system browser, which has no session. Empty on
 * the web: the web flow is unchanged.
 */
export function linkRelayQuery(
  env: { native: boolean; scheme: string | undefined } = {
    native: isNativePlatform(),
    scheme: NATIVE_OAUTH_SCHEME,
  },
): string {
  return env.native && env.scheme ? `?appScheme=${encodeURIComponent(env.scheme)}` : "";
}
