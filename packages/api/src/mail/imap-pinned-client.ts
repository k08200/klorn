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
 *
 * What a hostile server may cost (design D4, review fix):
 *   - ONE connect budget covers the DNS wait AND the handshake, so a slow resolver
 *     cannot add to the connection timeout;
 *   - one wall-clock deadline covers the whole session, whatever it is doing, so a
 *     server that drips bytes cannot hold a poll (imapflow's own inactivity timer
 *     is reset by every byte);
 *   - a line, a literal and a whole response each have a size cap of a few MiB, set
 *     after the caller's options so they cannot be raised.
 */

import { ImapFlow, type ImapFlowOptions } from "imapflow";

import { armTimer } from "./imap-session-deadline.js";
import { sanitizeLogText } from "./log-text.js";
import { PinnedAddressError, resolvePinnedAddress } from "./pinned-address.js";

const MIB = 1024 * 1024;

/** RFC 2606: never resolves. What the library is given instead of the user's name. */
export const UNRESOLVABLE_PLACEHOLDER_HOST = "host.invalid";
/** A host that accepts the TCP connection but never finishes the handshake must not hold a poll. */
export const GENERIC_CONNECTION_TIMEOUT_MS = 15_000;
export const GENERIC_GREETING_TIMEOUT_MS = 10_000;
/**
 * The longest one session may last, from the start of connect() to the end. A poll
 * of 50 messages takes seconds; this only ever fires on a stuck or dripping server.
 */
export const GENERIC_SESSION_DEADLINE_MS = 90_000;
/** A response line: an ENVELOPE or a long SEARCH answer is well under this. */
export const GENERIC_MAX_LINE_BYTES = 2 * MIB;
/** One literal: the bounded TEXT slice is 64 KiB (generic-imap-bounds.ts). */
export const GENERIC_MAX_LITERAL_BYTES = 4 * MIB;
/** A whole response; imapflow needs it above the literal cap so a literal at the cap can arrive. */
export const GENERIC_MAX_RESPONSE_BYTES = 8 * MIB;
/**
 * Every byte the server may send in ONE session, all commands and responses together.
 * The per-response caps above bound one response, not a series of them: a SELECT that
 * answers NO makes imapflow LIST, and a flood of untagged LIST lines (each far under
 * every cap) was buffered without limit (confirmed: 400 x 1 MiB grew RSS by 585 MiB).
 * An honest poll or action reads a few MiB (a window of 50 messages with 64 KiB of
 * text each is about 3.5 MiB). The review of the generic IMAP PR measured the memory a
 * session retains at about 2x the wire bytes (the parser's buffers plus the decoded
 * strings), so the budget is also a memory bound: 12 MiB is ~3.4x an honest poll and
 * caps a hostile session near 24 MiB retained, where the earlier 32 MiB allowed ~64.
 */
export const GENERIC_SESSION_BYTE_BUDGET = 12 * MIB;
const MIN_TLS_VERSION = "TLSv1.2";

const CONNECT_TIMEOUT_MESSAGE = "connection timed out";

export interface PinnedClientArgs {
  /** The folded ASCII host name (generic-imap-host.ts). */
  hostname: string;
  port: number;
  /** Everything else (auth, logger, timeouts). Connection-shaping options are not accepted. */
  options: Omit<ImapFlowOptions, "host" | "port" | "secure" | "servername" | "tls" | "proxy">;
  /** Log prefix, e.g. "generic-imap". */
  logScope: string;
  /** Override of GENERIC_SESSION_DEADLINE_MS, for tests. */
  sessionDeadlineMs?: number;
}

/** `work`, unless `ms` pass first: then `onExpire` runs and the result is a timeout error. */
function withDeadline<T>(ms: number, work: Promise<T>, onExpire: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = armTimer(ms, () => {
      onExpire();
      reject(new Error(CONNECT_TIMEOUT_MESSAGE));
    });
    work.then(
      (value) => {
        cancel();
        resolve(value);
      },
      (err: unknown) => {
        cancel();
        reject(err);
      },
    );
  });
}

function logRefusal(logScope: string, hostname: string, err: unknown): void {
  if (err instanceof PinnedAddressError) {
    const resolver = err.resolverCode ? ` (${err.resolverCode})` : "";
    const blocked = err.blocked.length > 0 ? ` [${err.blocked.join(", ")}]` : "";
    console.warn(
      `[${logScope}] refused a connection to ${hostname}: ${err.code}${resolver}${blocked}`,
    );
  } else if (err instanceof Error && err.message === CONNECT_TIMEOUT_MESSAGE) {
    console.warn(`[${logScope}] connection to ${hostname} ${CONNECT_TIMEOUT_MESSAGE}`);
  } else {
    console.warn(`[${logScope}] connect to ${hostname} failed: ${sanitizeLogText(err)}`);
  }
}

/**
 * Count the bytes of the whole session at the stream every received byte is piped into
 * (imapflow's `streamer`, written by the socket), so every command is covered, and cut
 * the session off the moment the budget is exceeded: the connection is closed and the
 * bytes that crossed the line, and every later one, never reach the parser. A library
 * build without that stream is left as it is.
 */
function budgetSessionBytes(
  client: ImapFlow,
  who: { hostname: string; logScope: string },
  cutOff: () => void,
): void {
  const streamer = (client as unknown as { streamer?: ByteSink }).streamer;
  if (!streamer || typeof streamer.write !== "function") return;
  const forward = streamer.write.bind(streamer);
  let received = 0;
  let exhausted = false;
  streamer.write = (chunk, ...rest) => {
    if (exhausted) return true; // keep the socket draining; the session is already closing
    received += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    if (received <= GENERIC_SESSION_BYTE_BUDGET) return forward(chunk, ...rest);
    exhausted = true;
    console.warn(
      `[${who.logScope}] ${who.hostname}: the session exceeded its ${GENERIC_SESSION_BYTE_BUDGET / MIB} MiB byte budget; closed`,
    );
    cutOff();
    return true;
  };
}

interface ByteSink {
  write: (chunk: Buffer | Uint8Array | string, ...rest: unknown[]) => boolean;
}

export function createPinnedImapClient(args: PinnedClientArgs): ImapFlow {
  const {
    hostname,
    port,
    options,
    logScope,
    sessionDeadlineMs = GENERIC_SESSION_DEADLINE_MS,
  } = args;
  const connectBudgetMs = options.connectionTimeout ?? GENERIC_CONNECTION_TIMEOUT_MS;

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
    // After the caller's options: a caller cannot raise these.
    maxLineLength: GENERIC_MAX_LINE_BYTES,
    maxLiteralSize: GENERIC_MAX_LITERAL_BYTES,
    maxResponseSize: GENERIC_MAX_RESPONSE_BYTES,
    host: UNRESOLVABLE_PLACEHOLDER_HOST,
    port,
    secure: true,
    servername: hostname,
    tls: tlsTarget,
  });

  const connectUnpinned = client.connect.bind(client);
  const closeClient = client.close.bind(client);
  let closed = false;
  let cancelSessionDeadline: () => void = () => {};

  /** Hard close, and refuse any connect that is still waiting on DNS. */
  const hardClose = (): void => {
    closed = true;
    closeClient();
  };

  client.close = () => {
    cancelSessionDeadline();
    hardClose();
  };
  // The connection ended by itself (error, server BYE): nothing is left to cut off.
  client.on("close", () => cancelSessionDeadline());
  budgetSessionBytes(client, { hostname, logScope }, () => {
    cancelSessionDeadline();
    hardClose();
  });

  const connectPinned = async (): Promise<void> => {
    // Fresh on every connection: nothing is remembered from an earlier one.
    const pin = await resolvePinnedAddress(hostname);
    if (closed) throw new Error("connection closed before it started");
    tlsTarget.host = pin.address;
    await connectUnpinned();
  };

  client.connect = async () => {
    cancelSessionDeadline = armTimer(sessionDeadlineMs, hardClose);
    try {
      await withDeadline(connectBudgetMs, connectPinned(), hardClose);
    } catch (err) {
      cancelSessionDeadline();
      logRefusal(logScope, hostname, err);
      throw err;
    }
  };

  return client;
}
