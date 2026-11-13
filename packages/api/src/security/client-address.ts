import { isIP, isIPv4, isIPv6 } from "node:net";

/**
 * The client address behind every per-address decision: the HTTP rate limits,
 * the scan exemption (RATE_LIMIT_ALLOW_IPS), the in-memory throttles and the
 * address recorded on a device session. It is the ONLY place that reads a
 * forwarding header; a guard test fails on any other read.
 *
 * A header says whatever the sender wants unless the deployment's own ingress
 * writes it, so a header is trusted only when CLIENT_IP_SOURCE names it:
 *
 * - `socket` (default off Render): the TCP peer. Nothing the client sends can
 *   change it. Behind a proxy it is the proxy, so all clients share a bucket.
 * - `cf-connecting-ip` (default on Render): Cloudflare writes this header for
 *   the connecting client. Trust it only where Cloudflare is the sole way in.
 *   Render serves onrender.com and custom domains through its Cloudflare edge;
 *   measured 2026-11-09, that edge answers a request that already carries the
 *   header with a 403 (Cloudflare error 1000), so it never reaches the API.
 *   Self-hosted behind Cloudflare, firewall the origin to Cloudflare's ranges
 *   or use a tunnel.
 * - `x-forwarded-for`: the entry TRUSTED_PROXY_HOPS positions from the right,
 *   i.e. the one written by the outermost proxy you run. Everything to its
 *   left came from the client. Use behind Caddy, nginx or Traefik, and keep
 *   the API port reachable only through the proxy.
 *
 * A trusted header that is absent or malformed falls back to the TCP peer.
 * docs/self-hosting.md ("Client address") is the operator-facing version.
 */

export type ClientIpSource = "socket" | "cf-connecting-ip" | "x-forwarded-for";

export interface ClientAddressConfig {
  readonly source: ClientIpSource;
  /** Proxies you run in front of the API (x-forwarded-for only). */
  readonly trustedProxyHops: number;
}

export interface ClientAddressRequest {
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
  readonly socket?: { readonly remoteAddress?: string };
}

type Env = Readonly<Record<string, string | undefined>>;

const SOURCES: readonly ClientIpSource[] = ["socket", "cf-connecting-ip", "x-forwarded-for"];
const DEFAULT_PROXY_HOPS = 1;
/** Sanity bound: no real deployment chains more proxies than this. */
const MAX_PROXY_HOPS = 10;
const UNKNOWN = "unknown";
const IPV4_MAPPED_PREFIX = "::ffff:";
/** 16-bit groups in a whole IPv6 address. */
const IPV6_GROUPS = 8;
/** 16-bit groups in a /64 — the prefix an IPv6 client is allocated. */
const IPV6_PREFIX_GROUPS = 4;

function isSource(value: string): value is ClientIpSource {
  return (SOURCES as readonly string[]).includes(value);
}

function parseSource(raw: string | undefined, onRender: boolean): ClientIpSource {
  const value = raw?.trim().toLowerCase() ?? "";
  if (value === "") return onRender ? "cf-connecting-ip" : "socket";
  if (!isSource(value)) {
    throw new Error(`CLIENT_IP_SOURCE must be one of ${SOURCES.join(", ")} (got "${raw}")`);
  }
  return value;
}

function parseHops(raw: string | undefined): number {
  const value = raw?.trim() ?? "";
  if (value === "") return DEFAULT_PROXY_HOPS;
  const hops = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(hops) || hops < 1 || hops > MAX_PROXY_HOPS) {
    throw new Error(
      `TRUSTED_PROXY_HOPS must be an integer from 1 to ${MAX_PROXY_HOPS} (got "${raw}")`,
    );
  }
  return hops;
}

/** Throws on a value it does not understand: a typo must not silently pick a source. */
export function resolveClientAddressConfig(env: Env): ClientAddressConfig {
  const source = parseSource(env.CLIENT_IP_SOURCE, env.RENDER === "true");
  // The hop count only means something for x-forwarded-for; elsewhere a stray
  // value must not fail the boot.
  const trustedProxyHops =
    source === "x-forwarded-for" ? parseHops(env.TRUSTED_PROXY_HOPS) : DEFAULT_PROXY_HOPS;
  return { source, trustedProxyHops };
}

/** For the boot log: the source, plus the hop count where it applies. */
export function describeClientAddressConfig(config: ClientAddressConfig): string {
  return config.source === "x-forwarded-for"
    ? `source=${config.source} trustedProxyHops=${config.trustedProxyHops}`
    : `source=${config.source}`;
}

/**
 * One plain IP literal, lowercased, with the IPv4-mapped IPv6 form unwrapped;
 * else null. A zone id (`fe80::1%eth0`) is refused: it is unbounded text no
 * client address needs.
 */
function normalizeAddress(raw: string | undefined): string | null {
  const value = raw?.trim().toLowerCase() ?? "";
  if (value.includes("%") || isIP(value) === 0) return null;
  if (value.startsWith(IPV4_MAPPED_PREFIX)) {
    const v4 = value.slice(IPV4_MAPPED_PREFIX.length);
    if (isIPv4(v4)) return v4;
  }
  return value;
}

function peerAddress(request: ClientAddressRequest): string {
  return normalizeAddress(request.socket?.remoteAddress) ?? UNKNOWN;
}

function fromCloudflare(request: ClientAddressRequest): string | null {
  const header = request.headers?.["cf-connecting-ip"];
  // Repeated or comma-joined values are not something the edge writes.
  return typeof header === "string" ? normalizeAddress(header) : null;
}

function fromForwardedFor(request: ClientAddressRequest, hops: number): string | null {
  const header = request.headers?.["x-forwarded-for"];
  if (header === undefined) return null;
  const chain = (Array.isArray(header) ? header.join(",") : header).split(",");
  if (chain.length < hops) return null;
  return normalizeAddress(chain[chain.length - hops]);
}

export function deriveClientAddress(
  request: ClientAddressRequest,
  config: ClientAddressConfig,
): string {
  switch (config.source) {
    case "cf-connecting-ip":
      return fromCloudflare(request) ?? peerAddress(request);
    case "x-forwarded-for":
      return fromForwardedFor(request, config.trustedProxyHops) ?? peerAddress(request);
    case "socket":
      return peerAddress(request);
  }
}

/**
 * The client address under the process configuration. Reads the environment
 * per call (a few property reads) so tests can switch sources; index.ts
 * resolves it once at boot to fail fast on a bad value.
 */
export function clientAddress(request: ClientAddressRequest, env: Env = process.env): string {
  return deriveClientAddress(request, resolveClientAddressConfig(env));
}

/** One group with its leading zeros dropped, so `0db8` and `db8` are one key. */
function canonicalGroup(group: string): string {
  return Number.parseInt(group, 16).toString(16);
}

/**
 * The groups one side of `::` spells out. A dotted-quad tail is the last two
 * groups; its value never reaches a /64, so only its width is kept.
 */
function spelledGroups(part: string | undefined): string[] {
  if (part === undefined || part === "") return [];
  return part.split(":").flatMap((group) => (group.includes(".") ? ["0", "0"] : [group]));
}

/**
 * The /64 an IPv6 address sits in; an IPv4 address (or the unknown marker)
 * unchanged.
 *
 * The address is expanded to all eight groups first: `::` can end inside the
 * prefix (RFC 5952 writes 2001:0:0:1:5:6:7:8 as 2001::1:5:6:7:8), so groups
 * right of it can belong to the /64 too.
 */
function addressBucket(address: string): string {
  if (!isIPv6(address)) return address;
  const [head, tail] = address.split("::");
  const left = spelledGroups(head);
  const right = spelledGroups(tail);
  const elided = tail === undefined ? 0 : IPV6_GROUPS - left.length - right.length;
  const groups = [...left, ...Array.from({ length: elided }, () => "0"), ...right];
  return groups.slice(0, IPV6_PREFIX_GROUPS).map(canonicalGroup).join(":");
}

/**
 * The key a per-client meter should count on: an IPv6 client by its /64, an
 * IPv4 client by its own address.
 *
 * `clientAddress` identifies one address, which is what a device-session
 * record or a scan exemption wants. A meter that hands out a free, server-paid
 * resource wants one *client*, and an IPv6 client is normally allocated a whole
 * /64 — ~1.8e19 addresses it can rotate through at no cost. Counting those
 * separately means a per-address cap bounds nothing. IPv4 is left alone: one
 * address is one host there, and grouping would punish a shared NAT.
 */
export function clientAddressBucket(request: ClientAddressRequest, env: Env = process.env): string {
  return addressBucket(clientAddress(request, env));
}

/**
 * True when the TCP peer is the only source but the request carries a
 * forwarding header: the API probably sits behind a proxy with
 * CLIENT_IP_SOURCE unset, so every client shares the proxy's bucket.
 */
export function looksProxiedWithoutSource(
  request: ClientAddressRequest,
  config: ClientAddressConfig,
): boolean {
  if (config.source !== "socket") return false;
  const headers = request.headers ?? {};
  return headers["x-forwarded-for"] !== undefined || headers["cf-connecting-ip"] !== undefined;
}
