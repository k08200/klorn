/**
 * Desktop shell configuration (main process). Both URLs are env-overridable so
 * the same shell runs against local dev, a self-hosted deploy, or production
 * without a rebuild.
 *
 * Defaults match the monorepo dev ports: web (Next.js) on 8001, api (Fastify)
 * on 3001. Values are validated to http(s) at startup — a malformed or
 * non-web-scheme override is rejected (and logged), never loaded.
 */

/** Only http(s) is ever navigated to or loaded. Blocks file:, javascript:, data:. */
const SAFE_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

function validatedUrl(value: string, fallback: string): string {
  try {
    if (SAFE_PROTOCOLS.has(new URL(value).protocol)) return value;
    console.warn(`[desktop] ignoring non-http(s) URL "${value}" — using ${fallback}`);
  } catch {
    console.warn(`[desktop] ignoring malformed URL "${value}" — using ${fallback}`);
  }
  return fallback;
}

const WEB_DEFAULT = "http://localhost:8001";
const API_DEFAULT = "http://localhost:3001";

// Re-exported so main-process callers can keep importing it from config; the
// definition lives in constants.ts (no side effects) so the sandboxed preload
// can share it without running this module's process.env reads.
export { KLORN_AUTH_TOKEN_KEY } from "./constants.js";

/** The Klorn web app the shell renders. */
export const KLORN_WEB_URL = validatedUrl(
  process.env.KLORN_DESKTOP_URL ?? WEB_DEFAULT,
  WEB_DEFAULT,
);

/** The Klorn API base — where the shared ontology read surface lives. */
export const KLORN_API_URL = validatedUrl(process.env.KLORN_API_URL ?? API_DEFAULT, API_DEFAULT);

/**
 * Is a navigation target an http(s) URL internal to the Klorn web app? Any
 * non-http(s) scheme (file:, javascript:, data:) is rejected outright so it can
 * never reach shell.openExternal.
 */
export function isInternalUrl(target: string): boolean {
  try {
    const url = new URL(target);
    if (!SAFE_PROTOCOLS.has(url.protocol)) return false;
    return url.origin === new URL(KLORN_WEB_URL).origin;
  } catch {
    return false;
  }
}

/** Whether an external link is safe to hand to the OS browser (http(s) only). */
export function isSafeExternalUrl(target: string): boolean {
  try {
    return SAFE_PROTOCOLS.has(new URL(target).protocol);
  } catch {
    return false;
  }
}

/**
 * Does this navigation target the API's Google login *start* endpoint? The web
 * app's "Sign in with Google" button points here, which is cross-origin to the
 * shell — so instead of kicking a half-flow out to the OS browser (where the
 * JWT would land in the browser, not the shell), the shell intercepts it and
 * runs the native browser-bounce + nonce-poll flow (see desktop-login.ts).
 *
 * Matches only the bare start path; the `?source=desktop&nonce=` URL the native
 * flow itself opens is deliberately excluded so interception can't recurse.
 */
export function isGoogleLoginStart(target: string): boolean {
  try {
    const url = new URL(target);
    if (!SAFE_PROTOCOLS.has(url.protocol)) return false;
    if (url.origin !== new URL(KLORN_API_URL).origin) return false;
    if (url.pathname !== "/api/auth/google/login") return false;
    return url.searchParams.get("source")?.toLowerCase() !== "desktop";
  } catch {
    return false;
  }
}
