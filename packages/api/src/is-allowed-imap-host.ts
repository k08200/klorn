/**
 * SSRF allowlist for user-supplied IMAP hosts.
 *
 * The Naver IMAP connect endpoint takes a `host` from the request body and opens
 * a real TLS connection to it (on connect AND on every subsequent poll). Without
 * an allowlist a logged-in user can point the server at internal infrastructure
 * (169.254.169.254:993, localhost, an internal hostname) and use the reflected
 * connection error as a blind-SSRF reachability oracle.
 *
 * Naver is the only supported provider today, so the allowlist is exact: a host
 * on the naver.com domain, IMAPS port only. Adding a provider later means adding
 * its host here on purpose — not silently accepting arbitrary hosts.
 */

const ALLOWED_IMAP_PORTS = new Set(["993"]); // IMAPS (TLS) only
const ALLOWED_IMAP_HOSTS = new Set(["imap.naver.com"]);
const ALLOWED_IMAP_HOST_SUFFIXES = [".naver.com"];

export function isAllowedImapHost(hostInput: string): boolean {
  const trimmed = hostInput.trim().toLowerCase();
  if (!trimmed) return false;

  const parts = trimmed.split(":");
  // Exactly host[:port]. More than one colon (e.g. a bare IPv6 literal) is
  // rejected — we don't support those and they're a classic SSRF vector.
  if (parts.length > 2) return false;
  const host = parts[0];
  const port = parts[1] ?? "993";

  if (!host) return false;
  if (!ALLOWED_IMAP_PORTS.has(port)) return false;
  if (ALLOWED_IMAP_HOSTS.has(host)) return true;
  return ALLOWED_IMAP_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}
