/**
 * Resolve-then-pin for a user-supplied IMAP host (step B4, design D2 in
 * docs/providers/unified-platform-plan.md): resolve the name, refuse it when there
 * is no answer or when ANY answer is not a public address, and return ONE checked
 * address for the connection to use.
 *
 * Nothing is cached. Every connection (connect-route verify, poll, action) calls
 * this afresh, so a name an attacker re-points at an internal address after an
 * earlier check is refused the next time, and there is no gap between the check and
 * the connection because the connection targets the checked address itself.
 *
 * The error says only what class of failure it was. It carries no address and no
 * text from the resolver: callers turn it into one generic user message, and log
 * the class on the server.
 */

import net from "node:net";

import { resolveHostAddresses } from "./host-resolver.js";
import { isPublicAddress } from "./ip-policy.js";

export type PinnedAddressErrorCode = "unresolvable" | "blocked-address";

export class PinnedAddressError extends Error {
  readonly code: PinnedAddressErrorCode;
  /** The non-public answers, for the server log only (never for a user). */
  readonly blocked: readonly string[];

  constructor(code: PinnedAddressErrorCode, blocked: readonly string[] = []) {
    super(
      code === "blocked-address"
        ? "host did not resolve to a public address"
        : "host did not resolve to any address",
    );
    this.name = "PinnedAddressError";
    this.code = code;
    // Only well-formed addresses are kept: the list ends up in a log line.
    this.blocked = blocked.filter((address) => net.isIP(address) !== 0).slice(0, 4);
  }
}

export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

export type HostResolver = (host: string) => Promise<readonly string[]>;

/**
 * The address to connect to for `host`. Prefers the first IPv4 answer (the egress
 * may have no IPv6 route), else the first IPv6 one. Throws PinnedAddressError.
 */
export async function resolvePinnedAddress(
  host: string,
  resolve: HostResolver = resolveHostAddresses,
): Promise<PinnedAddress> {
  let answers: readonly string[];
  try {
    answers = await resolve(host);
  } catch {
    throw new PinnedAddressError("unresolvable");
  }
  if (answers.length === 0) throw new PinnedAddressError("unresolvable");

  const blocked = answers.filter((answer) => !isPublicAddress(answer));
  if (blocked.length > 0) throw new PinnedAddressError("blocked-address", blocked);

  const address = answers.find((answer) => !answer.includes(":")) ?? answers[0];
  return { address, family: address.includes(":") ? 6 : 4 };
}
