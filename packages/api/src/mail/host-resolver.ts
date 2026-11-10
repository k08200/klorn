/**
 * The default DNS resolver for user-supplied IMAP hosts (step B4, design D2).
 *
 * Asks DNS directly through `node:dns` Resolver (c-ares), never `dns.lookup`: the
 * answer Klorn checks must be the answer of DNS itself, not something /etc/hosts,
 * nsswitch or a search domain turned a name into. Both A and AAAA are asked; IPv4
 * answers come first. Each query has a timeout, so a stalling name server cannot
 * hold a connect, a poll or an action for long.
 *
 * It is the only place the name is resolved: the connection goes to the address
 * chosen from these answers (pinned-address.ts), never to the name.
 */

import { Resolver } from "node:dns/promises";

/** Per query, per try. With DNS_TRIES this bounds a silent name server to about 6 s. */
export const DNS_QUERY_TIMEOUT_MS = 3_000;
const DNS_TRIES = 2;

/**
 * Every A and AAAA answer for `host`, IPv4 first. Empty when the name exists but
 * has no address. Throws when neither family could be resolved at all (the first
 * failure); one family failing while the other answered is not an error, since only
 * the answered addresses can ever be connected to.
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
