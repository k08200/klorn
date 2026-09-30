/**
 * Shared IMAP connection plumbing: how a client is constructed, which rows may
 * be connected at all, and how a session ends.
 *
 * The poller (imap-accounts.ts / imap-sync.ts), the connect route's verify
 * handshake and the flag actions (providers/imap*.ts) all open TLS sockets to a
 * host taken from a LinkedInboxAccount row, so there is exactly one copy of the
 * client construction, of the pre-connect guards and of the teardown. This
 * module imports no ingestion code on purpose: the provider action import graph
 * must stay free of the persist / judge chain (which itself imports the
 * provider dispatch).
 */

import { ImapFlow } from "imapflow";

import { hostMatchesProvider, type ImapProviderConfig } from "./imap-providers.js";
import { isAllowedImapHost } from "./is-allowed-imap-host.js";

const DEFAULT_IMAPS_PORT = 993;

export function parseImapHost(host: string): { host: string; port: number } {
  const [h, p] = host.split(":");
  return { host: h, port: Number(p) || DEFAULT_IMAPS_PORT };
}

interface ImapClientOptions {
  /** Pins the host: the client is only ever built for THIS provider's host. */
  provider: ImapProviderConfig;
  /** "imap.naver.com:993" — the stored form. */
  host: string;
  email: string;
  password: string;
  socketTimeout: number;
  /** Omitted = imapflow's default. Only the action path sets these. */
  connectionTimeout?: number;
  greetingTimeout?: number;
  /** LinkedInboxAccount row id, for log lines only. Never a credential. */
  accountId?: string;
}

/**
 * Build the client. This is the sink every IMAP socket goes through, so the
 * SSRF allowlist and the host↔provider pin are enforced HERE as well as by the
 * callers: a host that reaches this point by any path still cannot open a
 * connection to an internal target, nor connect a NAVER row to the iCloud host.
 *
 * imapflow emits `'error'` for socket failures that arrive while no command is
 * pending; with no listener Node rethrows it as an uncaught exception, and
 * nothing in this process catches that. The listener only logs, and never
 * carries credentials.
 */
export function createImapClient(opts: ImapClientOptions): ImapFlow {
  const { provider } = opts;
  if (!isAllowedImapHost(opts.host) || !hostMatchesProvider(opts.host, provider)) {
    throw new Error(`IMAP host is not allowed for ${provider.label}`);
  }
  const { host, port } = parseImapHost(opts.host);
  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user: opts.email, pass: opts.password },
    logger: false,
    socketTimeout: opts.socketTimeout,
    ...(opts.connectionTimeout !== undefined ? { connectionTimeout: opts.connectionTimeout } : {}),
    ...(opts.greetingTimeout !== undefined ? { greetingTimeout: opts.greetingTimeout } : {}),
  });
  const where = opts.accountId ? ` for row ${opts.accountId}` : "";
  client.on("error", (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[${provider.logScope}] connection error${where}: ${message}`);
  });
  return client;
}

/** End a session whatever happened: LOGOUT, and a hard close if that fails. */
export async function endImapSession(client: ImapFlow): Promise<void> {
  try {
    await client.logout();
  } catch {
    // The connection is already gone or broken; the hard close below is the
    // recovery, and there is nothing a caller could do with this error.
  } finally {
    client.close();
  }
}

export type ImapRowRejection =
  | "missing-credentials"
  | "host-not-allowlisted"
  | "host-provider-mismatch";

export type ImapRowCheck =
  | { ok: true; email: string; host: string; passwordCipher: string }
  | { ok: false; reason: ImapRowRejection };

/**
 * May this stored row be connected? Returns the narrowed credentials, or why
 * not.
 *
 * Re-validates at the connection boundary, not only at the /connect write: a
 * host that reaches a row by any other path must never open a TLS connection
 * to an internal target, nor connect a NAVER row to the iCloud host (or vice
 * versa). A row without credentials is half-migrated or hand-edited and rots
 * visibly instead of throwing.
 */
export function checkImapRow(
  row: {
    email: string | null;
    imapHost: string | null;
    imapPasswordCipher: string | null;
  },
  provider: ImapProviderConfig,
): ImapRowCheck {
  const { email, imapHost, imapPasswordCipher } = row;
  if (!email || !imapHost || !imapPasswordCipher) {
    return { ok: false, reason: "missing-credentials" };
  }
  if (!isAllowedImapHost(imapHost)) return { ok: false, reason: "host-not-allowlisted" };
  if (!hostMatchesProvider(imapHost, provider)) {
    return { ok: false, reason: "host-provider-mismatch" };
  }
  return { ok: true, email, host: imapHost, passwordCipher: imapPasswordCipher };
}
