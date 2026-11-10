/**
 * Validate an outbound HTTPS target (Web Push endpoints, RFC 8058 one-click
 * unsubscribe URLs) against SSRF-style targets. Rejects non-HTTPS, loopback
 * and internal DNS names (with or without trailing dots), and any IP literal
 * that is not a public, globally routable unicast address — the same policy
 * the generic IMAP guard uses (mail/ip-policy.ts): RFC1918, loopback,
 * link-local and cloud metadata, CGNAT, benchmarking, documentation,
 * multicast, reserved, and on IPv6 everything outside 2000::/3 (ULA, site-
 * local, NAT64, the IPv4-compatible form) plus 6to4/Teredo/documentation
 * inside it. Endpoints come from users or from mail senders, so they are
 * re-validated every time they are used.
 */

import { isIP } from "node:net";
import { isPublicAddress } from "../mail/ip-policy.js";

const LOOPBACK_HOSTS = new Set(["localhost"]);
const INTERNAL_SUFFIXES = [".internal", ".local", ".localhost"];

function normalizeHost(hostname: string): string {
  // URL.hostname wraps IPv6 in brackets; strip them for comparison. A trailing
  // dot is the same name to DNS ("localhost." is localhost), so strip those too.
  const lower = hostname.toLowerCase().replace(/\.+$/, "");
  return lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
}

export function isSafePushEndpoint(endpoint: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;

  const host = normalizeHost(parsed.hostname);
  if (!host) return false;
  if (isIP(host) !== 0) return isPublicAddress(host);
  if (LOOPBACK_HOSTS.has(host)) return false;
  if (INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) return false;
  return true;
}

/**
 * True when a RESOLVED IP literal is loopback/private/link-local/ULA/etc.
 * Used at CONNECT time (from a DNS lookup) to close the rebinding gap that the
 * hostname-string check in isSafePushEndpoint cannot: a public-looking name
 * whose A/AAAA record points at an internal address (rebindable per query).
 */
export function isPrivateIp(address: string): boolean {
  return !isPublicAddress(normalizeHost(address));
}
