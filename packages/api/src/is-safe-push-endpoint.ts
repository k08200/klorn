/**
 * Validate a Web Push endpoint URL against SSRF-style targets before calling
 * `webPush.sendNotification`. Rejects non-HTTPS, loopback, internal DNS names,
 * private IPv4 (RFC1918, loopback /8, link-local), and private IPv6 (loopback,
 * unspecified, ULA fc00::/7, link-local fe80::/10, IPv4-mapped wrapping a
 * private IPv4). Subscription endpoints come from the browser via the user,
 * so we re-validate every time we read from the DB.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const INTERNAL_SUFFIXES = [".internal", ".local"];

const IPV4_PATTERN = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/;

function isPrivateIPv4(host: string): boolean {
  const match = host.match(IPV4_PATTERN);
  if (!match) return false;
  const [a, b] = match.slice(1, 3).map(Number);
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback /8 — the literal-only check missed 127.0.0.2+
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

/**
 * Expand an IPv6 textual address (already bracket-stripped and lowercased)
 * into its 8 16-bit groups. Returns null when the string is not a valid
 * IPv6 address — plain hostnames never contain ":" so they can't reach this.
 * A trailing dotted-quad ("::ffff:10.0.0.1") is folded into the last two
 * groups first, per RFC 4291 §2.2. In practice `new URL().hostname` already
 * canonicalizes dotted-quad IPv6 into hex groups before this runs, so that
 * branch is belt-and-suspenders for any direct caller, not the push path.
 */
function expandIPv6(host: string): number[] | null {
  let s = host;
  if (s.includes(".")) {
    const lastColon = s.lastIndexOf(":");
    const tail = s.slice(lastColon + 1);
    const match = tail.match(IPV4_PATTERN);
    if (!match) return null;
    const octets = match.slice(1).map(Number);
    if (octets.some((o) => o > 255)) return null;
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    s = `${s.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let parts: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    parts = [...head, ...Array(fill).fill("0"), ...tail];
  } else {
    parts = head;
  }
  if (parts.length !== 8) return null;

  const groups: number[] = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
}

function isPrivateIPv6(host: string): boolean {
  if (!host.includes(":")) return false;
  const groups = expandIPv6(host);
  if (!groups) return false;
  const headIsZero = groups.slice(0, 7).every((g) => g === 0);
  if (headIsZero && (groups[7] === 0 || groups[7] === 1)) return true; // :: and ::1
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  // Both IPv4 embeddings whose last 32 bits are an IPv4 address: the mapped
  // form ::ffff:a.b.c.d (groups[5]=0xffff) and the deprecated compatible form
  // ::a.b.c.d (groups[5]=0). Re-run the IPv4 policy on the embedded address so
  // a private/loopback v4 can't be smuggled through either wrapper. The
  // compatible form isn't routed by modern stacks, but block it anyway rather
  // than depend on that staying true.
  const firstFiveZero = groups.slice(0, 5).every((g) => g === 0);
  if (firstFiveZero && (groups[5] === 0xffff || groups[5] === 0)) {
    const embedded = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    return isPrivateIPv4(embedded);
  }
  return false;
}

function normalizeHost(hostname: string): string {
  // URL.hostname wraps IPv6 in brackets; strip them for comparison.
  const lower = hostname.toLowerCase();
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
  if (LOOPBACK_HOSTS.has(host)) return false;
  if (INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) return false;
  if (isPrivateIPv4(host)) return false;
  if (isPrivateIPv6(host)) return false;

  return true;
}
