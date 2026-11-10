/**
 * The parts of the app config that are pure and environment-free, so the Vite
 * config (Node) can share them with the app. See config.ts for the rest.
 *
 * Prod is `api.klorn.ai`, Klorn's own name for the API (a CNAME to the same
 * Render service the web and Mac apps reach as klorn-api.onrender.com; live and
 * TLS-audited in docs/casa/evidence-map.md). A store binary cannot be hot-fixed,
 * so it pins the domain Klorn controls: the API can move hosts without an app
 * update. Nothing in the app depends on the host name — OAuth state is a signed
 * token in the URL, not a cookie (routes/auth.ts), and the CSP's connect-src is
 * built from this value (vite.config.ts).
 */
export const PROD_API_BASE = "https://api.klorn.ai";
export const DEV_API_BASE = "http://localhost:3001";

/** The custom scheme the API relays OAuth results to (NATIVE_OAUTH_SCHEMES). */
export const NATIVE_OAUTH_SCHEME = "ai.klorn.app";

/**
 * Plain http is accepted ONLY for local development hosts, so a bad build env
 * can never send the Bearer token off-TLS to a remote host (same rule as the
 * Mac app's Config.validated). Returns the base without a trailing slash, or
 * null for anything unusable.
 */
export function validateApiBase(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(":", "").toLowerCase();
  if (scheme !== "https" && scheme !== "http") return null;
  if (scheme === "http") {
    const host = url.hostname.toLowerCase();
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]" && host !== "10.0.2.2") {
      return null;
    }
  }
  return raw.replace(/\/+$/, "");
}
