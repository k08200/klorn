/**
 * Rate-limit exemption for an authorized security scan.
 *
 * A CASA DAST assessment fires thousands of requests from a small set of source
 * addresses. Measured against production on 2026-08-12, 60 sequential requests
 * from one IP already drew 11× 429 — an unthrottled scanner would come back
 * with a half-finished report and burn a revalidation cycle.
 *
 * This is deliberately env-driven and empty by default: the exemption exists
 * only while `RATE_LIMIT_ALLOW_IPS` names the assessor's ranges, and clearing
 * the variable closes it again. Every parse failure drops the rule rather than
 * widening it — a typo must never turn into an open door.
 */

export interface CidrRule {
  /** Network address as a 32-bit unsigned integer. */
  readonly network: number;
  /** Bit length of the prefix, 8–32. */
  readonly prefix: number;
}

/**
 * A /0 would exempt the whole internet and a very short prefix is almost
 * certainly a typo, so the parser refuses anything wider than a /8.
 */
const MIN_PREFIX = 8;
const MAX_PREFIX = 32;

function toUint32(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

/** Parse `RATE_LIMIT_ALLOW_IPS` into rules. Unparseable entries are dropped. */
export function parseAllowedCidrs(raw: string | undefined | null): CidrRule[] {
  if (!raw) return [];
  const rules: CidrRule[] = [];

  for (const entry of raw.split(",")) {
    const token = entry.trim();
    if (!token) continue;

    const [address, prefixText] = token.split("/");
    const network = toUint32(address ?? "");
    if (network === null) continue;

    const prefix = prefixText === undefined ? MAX_PREFIX : Number(prefixText);
    if (!Number.isInteger(prefix) || prefix < MIN_PREFIX || prefix > MAX_PREFIX) continue;

    // Normalise to the network address so a rule written as 198.51.100.42/24
    // still matches the whole /24 rather than nothing.
    const mask = prefix === 0 ? 0 : (0xffffffff << (MAX_PREFIX - prefix)) >>> 0;
    rules.push({ network: (network & mask) >>> 0, prefix });
  }

  return rules;
}

/** True when the client address falls inside one of the parsed rules. */
export function isRateLimitAllowedIp(
  clientIp: string | undefined | null,
  rules: readonly CidrRule[],
): boolean {
  if (!clientIp || rules.length === 0) return false;

  // IPv6 is out of scope: half-parsing v6 here would be a silent bypass, so a
  // v6 address never matches. security/client-address.ts already unwraps the
  // v4-mapped form (::ffff:a.b.c.d) before it gets here.
  const value = toUint32(clientIp);
  if (value === null) return false;

  return rules.some(({ network, prefix }) => {
    const mask = (0xffffffff << (MAX_PREFIX - prefix)) >>> 0;
    return (value & mask) >>> 0 === network;
  });
}
