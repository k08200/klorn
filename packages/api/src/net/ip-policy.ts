/**
 * Which addresses an outbound connection to a provider host may resolve to. One
 * rule: an address is usable only when it is a public, globally routable unicast
 * address.
 *
 * DUPLICATE, deliberately, for now: below this header the file is a verbatim copy of
 * `mail/ip-policy.ts` on the unmerged branch `feat/generic-imap` (step B4), made
 * for the CalDAV connector (step C3) so C3 does not depend on B4 landing first.
 * Whichever lands second moves its callers to ONE module (this neutral `net/`
 * location is the suggested home) and deletes the other copy. `notify/
 * is-safe-push-endpoint.ts` (`isPrivateIp`, a deny list with default-allow IPv6)
 * is a third, weaker policy and should move here in the same dedupe.
 *
 *   - IPv4 is a deny list of every special-purpose block (private, loopback,
 *     link-local including the cloud metadata address, CGNAT, documentation,
 *     benchmarking, multicast, reserved, broadcast).
 *   - IPv6 is default-deny: only global unicast 2000::/3 passes, minus the special
 *     blocks inside it (Teredo and protocol assignments, documentation, 6to4).
 *     Loopback, unique-local (AWS `fd00:ec2::254`), link-local, multicast, NAT64 and
 *     every other reserved block fall outside 2000::/3.
 *   - An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`, dotted or hex) is judged by
 *     the IPv4 address inside it, so `::ffff:10.0.0.1` is as private as 10.0.0.1.
 *
 * Anything that is not a plain address string fails closed. The parsing is strict
 * and written out here, not delegated: no zone ids, no brackets, no short forms
 * like `127.1`, no leading zeros.
 */

/** [network address, prefix length] of an IPv4 block. */
type V4Block = readonly [string, number];

/** Special-purpose IPv4 blocks that are never a public mail server. */
const BLOCKED_V4_BLOCKS: readonly V4Block[] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // CGNAT (Alibaba metadata 100.100.100.200)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, AWS/GCP/Azure metadata 169.254.169.254
  ["172.16.0.0", 12], // RFC 1918
  ["192.0.0.0", 24], // IETF protocol assignments (Oracle metadata 192.0.0.192)
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast (deprecated)
  ["192.168.0.0", 16], // RFC 1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, including 255.255.255.255
];

/** Special blocks INSIDE 2000::/3 that are not public mail servers: [groups, prefix length]. */
const BLOCKED_V6_BLOCKS: ReadonlyArray<readonly [readonly number[], number]> = [
  [[0x2001, 0, 0, 0, 0, 0, 0, 0], 23], // IETF protocol assignments: Teredo, benchmarking
  [[0x2001, 0x0db8, 0, 0, 0, 0, 0, 0], 32], // documentation
  [[0x2002, 0, 0, 0, 0, 0, 0, 0], 16], // 6to4
  [[0x3fff, 0, 0, 0, 0, 0, 0, 0], 20], // documentation
];

const IPV4_OCTET = /^(0|[1-9]\d{0,2})$/;
const IPV6_CHARS = /^[0-9a-fA-F:.]+$/;
const IPV6_GROUP = /^[0-9a-fA-F]{1,4}$/;
const GLOBAL_UNICAST_MASK = 0xe000;
const GLOBAL_UNICAST_PREFIX = 0x2000;
const V4_MAPPED_GROUP = 0xffff;

function parseIPv4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!IPV4_OCTET.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** The blocks as numbers, parsed once: [first address, size of the block]. */
const BLOCKED_V4: ReadonlyArray<readonly [number, number]> = BLOCKED_V4_BLOCKS.map(
  ([network, prefix]) => [parseIPv4(network) ?? Number.NaN, 2 ** (32 - prefix)] as const,
);

function inV4Block(address: number, [base, size]: readonly [number, number]): boolean {
  return Math.floor(address / size) === Math.floor(base / size);
}

/** The eight 16-bit groups of an IPv6 address, or null when `text` is not one. */
function parseIPv6(text: string): number[] | null {
  if (!IPV6_CHARS.test(text)) return null;
  let body = text;
  // A dotted IPv4 tail (::ffff:10.0.0.1) stands for the last two groups.
  const lastColon = body.lastIndexOf(":");
  if (body.includes(".")) {
    const tail = parseIPv4(body.slice(lastColon + 1));
    if (tail === null) return null;
    const high = Math.floor(tail / 65536).toString(16);
    const low = (tail % 65536).toString(16);
    body = `${body.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const halves = body.split("::");
  if (halves.length > 2) return null;
  const toGroups = (half: string): string[] => (half === "" ? [] : half.split(":"));
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  const given = [...head, ...tail];
  if (!given.every((group) => IPV6_GROUP.test(group))) return null;
  if (halves.length === 1) {
    if (given.length !== 8) return null;
  } else if (given.length > 7) {
    return null;
  }
  const zeros = Array.from({ length: 8 - given.length }, () => "0");
  const groups = halves.length === 2 ? [...head, ...zeros, ...tail] : given;
  return groups.map((group) => Number.parseInt(group, 16));
}

function inV6Block(
  groups: readonly number[],
  [network, prefix]: readonly [readonly number[], number],
): boolean {
  for (let i = 0; i < 8; i++) {
    const covered = prefix - i * 16;
    if (covered <= 0) return true;
    const mask = covered >= 16 ? 0xffff : (0xffff << (16 - covered)) & 0xffff;
    if ((groups[i] & mask) !== (network[i] & mask)) return false;
  }
  return true;
}

function isPublicV4(address: number): boolean {
  return !BLOCKED_V4.some((block) => inV4Block(address, block));
}

function isPublicV6(groups: readonly number[]): boolean {
  const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === V4_MAPPED_GROUP;
  if (mapped) return isPublicV4(groups[6] * 65536 + groups[7]);
  if ((groups[0] & GLOBAL_UNICAST_MASK) !== GLOBAL_UNICAST_PREFIX) return false;
  return !BLOCKED_V6_BLOCKS.some((block) => inV6Block(groups, block));
}

/** True only for a plain public unicast address; false for everything else. */
export function isPublicAddress(address: unknown): boolean {
  if (typeof address !== "string") return false;
  if (address.includes(":")) {
    const groups = parseIPv6(address);
    return groups !== null && isPublicV6(groups);
  }
  const v4 = parseIPv4(address);
  return v4 !== null && isPublicV4(v4);
}
