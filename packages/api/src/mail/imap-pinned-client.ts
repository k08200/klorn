/**
 * An imapflow client for a user-supplied host that connects to a CHECKED address,
 * never to the name (step B4, design D3 in docs/providers/unified-platform-plan.md).
 *
 * The client is built synchronously, like every other one, so the poller, the
 * verify handshake and the action sessions use it unchanged. Its `connect()` is
 * wrapped: each call resolves the name afresh, checks every answer
 * (pinned-address.ts) and only then gives imapflow the address. imapflow merges its
 * `tls` option over its own host and servername when it opens the socket, so:
 *
 *   socket target       tls.host = the checked IP (an IP literal: nothing to resolve)
 *   SNI and cert name   tls.servername = the host name, verification ON
 *
 * The constructor host is `host.invalid`: reserved (RFC 2606), it can never
 * resolve. If a future imapflow stopped honouring `tls.host`, the connection would
 * fail closed instead of the library resolving the user's name by itself. The wire
 * test (imap-pinned-wire.test.ts) runs the real library and pins this behaviour.
 *
 * Certificate verification is never relaxed, there is no plaintext or STARTTLS
 * path (implicit TLS on 993 only), and the protocol floor is TLS 1.2. A close()
 * that arrives while the name is still being resolved cancels the connect.
 */

import { ImapFlow, type ImapFlowOptions } from "imapflow";

import { PinnedAddressError, resolvePinnedAddress } from "./pinned-address.js";

/** RFC 2606: never resolves. What the library is given instead of the user's name. */
export const UNRESOLVABLE_PLACEHOLDER_HOST = "host.invalid";
/** A host that accepts the TCP connection but never finishes the handshake must not hold a poll. */
export const GENERIC_CONNECTION_TIMEOUT_MS = 15_000;
export const GENERIC_GREETING_TIMEOUT_MS = 10_000;
const MIN_TLS_VERSION = "TLSv1.2";

export interface PinnedClientArgs {
  /** The folded ASCII host name (generic-imap-host.ts). */
  hostname: string;
  port: number;
  /** Everything else (auth, logger, timeouts). Connection-shaping options are not accepted. */
  options: Omit<ImapFlowOptions, "host" | "port" | "secure" | "servername" | "tls" | "proxy">;
  /** Log prefix, e.g. "generic-imap". */
  logScope: string;
}

export function createPinnedImapClient(args: PinnedClientArgs): ImapFlow {
  const { hostname, port, options, logScope } = args;

  // Read by imapflow at connect time; `host` is filled in once the name is checked.
  const tlsTarget: {
    host?: string;
    servername: string;
    rejectUnauthorized: true;
    minVersion: "TLSv1.2";
  } = {
    servername: hostname,
    rejectUnauthorized: true,
    minVersion: MIN_TLS_VERSION,
  };

  const client = new ImapFlow({
    connectionTimeout: GENERIC_CONNECTION_TIMEOUT_MS,
    greetingTimeout: GENERIC_GREETING_TIMEOUT_MS,
    ...options,
    host: UNRESOLVABLE_PLACEHOLDER_HOST,
    port,
    secure: true,
    servername: hostname,
    tls: tlsTarget,
  });

  const connectUnpinned = client.connect.bind(client);
  const closeClient = client.close.bind(client);
  let closed = false;

  client.close = () => {
    closed = true;
    closeClient();
  };

  client.connect = async () => {
    try {
      // Fresh on every connection: nothing is remembered from an earlier one.
      const pin = await resolvePinnedAddress(hostname);
      if (closed) throw new Error("connection closed before it started");
      tlsTarget.host = pin.address;
    } catch (err) {
      if (err instanceof PinnedAddressError) {
        const seen = err.blocked.length > 0 ? ` (${err.blocked.join(", ")})` : "";
        console.warn(`[${logScope}] refused a connection to ${hostname}: ${err.code}${seen}`);
      }
      throw err;
    }
    return connectUnpinned();
  };

  return client;
}
