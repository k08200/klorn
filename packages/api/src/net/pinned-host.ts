/**
 * Resolve-then-pin for an outbound HTTPS connection to a provider host (step C3,
 * the CalDAV connector): resolve the name, refuse it when there is no answer or
 * when ANY answer is not a public address, and return ONE checked address for the
 * connection to use. The connection then goes to that address (the TLS name check
 * still uses the host name), so DNS cannot be re-pointed between the check and the
 * connect.
 *
 * DUPLICATE, deliberately, for now: the same design as `mail/host-resolver.ts` and
 * `mail/pinned-address.ts` on the unmerged branch `feat/generic-imap` (step B4),
 * which pins IMAP connections. Dedupe with net/ip-policy.ts (see its header).
 *
 * Nothing is cached: every request resolves afresh. Error messages carry no address
 * and no resolver text; the blocked answers are a separate field for the server log.
 */

import { Resolver } from "node:dns/promises";
import net from "node:net";

import { isPublicAddress } from "./ip-policy.js";

/** Per query, per try. With DNS_TRIES this bounds a silent name server to about 6 s. */
export const DNS_QUERY_TIMEOUT_MS = 3_000;
const DNS_TRIES = 2;
/** Blocked answers kept for one log line. */
const MAX_LOGGED_ANSWERS = 4;

export type HostResolver = (host: string) => Promise<readonly string[]>;

export type PinnedHostErrorCode = "unresolvable" | "blocked-address";

export class PinnedHostError extends Error {
  readonly code: PinnedHostErrorCode;
  /** The non-public answers, for the server log only (never for a user). */
  readonly blocked: readonly string[];

  constructor(code: PinnedHostErrorCode, blocked: readonly string[] = []) {
    super(
      code === "blocked-address"
        ? "host did not resolve to a public address"
        : "host did not resolve to any address",
    );
    this.name = "PinnedHostError";
    this.code = code;
    this.blocked = blocked
      .filter((address) => net.isIP(address) !== 0)
      .slice(0, MAX_LOGGED_ANSWERS);
  }
}

export interface PinnedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/**
 * Every A and AAAA answer for `host`, IPv4 first, asked of DNS itself (c-ares), never
 * `dns.lookup`, so /etc/hosts or a search domain cannot turn the name into something
 * else. Throws only when neither family resolved at all.
 */
export async function resolveHostAddresses(host: string): Promise<string[]> {
  const resolver = new Resolver({ timeout: DNS_QUERY_TIMEOUT_MS, tries: DNS_TRIES });
  const [v4, v6] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
  if (v4.status === "rejected" && v6.status === "rejected") throw v4.reason;
  return [
    ...(v4.status === "fulfilled" ? v4.value : []),
    ...(v6.status === "fulfilled" ? v6.value : []),
  ];
}

/**
 * The address to connect to for `host`: the first IPv4 answer (the egress may have
 * no IPv6 route), else the first IPv6 one. Throws PinnedHostError when the name has
 * no answer or when any answer is not public, so a multi-record answer cannot
 * smuggle an internal target in next to a public one.
 */
export async function resolvePinnedAddress(
  host: string,
  resolve: HostResolver = resolveHostAddresses,
): Promise<PinnedAddress> {
  let answers: readonly string[];
  try {
    answers = await resolve(host);
  } catch {
    throw new PinnedHostError("unresolvable");
  }
  if (answers.length === 0) throw new PinnedHostError("unresolvable");
  const blocked = answers.filter((answer) => !isPublicAddress(answer));
  if (blocked.length > 0) throw new PinnedHostError("blocked-address", blocked);
  const address = answers.find((answer) => !answer.includes(":")) ?? answers[0];
  return { address, family: address.includes(":") ? 6 : 4 };
}
