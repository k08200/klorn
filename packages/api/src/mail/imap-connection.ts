/**
 * Shared IMAP connection plumbing: how a client is constructed and which rows
 * may be connected at all.
 *
 * The poller (imap-accounts.ts / imap-sync.ts) and the flag actions
 * (providers/imap.ts) both open TLS sockets to a host taken from a
 * LinkedInboxAccount row, so there is exactly one copy of the client
 * construction and of the pre-connect guards. This module imports no ingestion
 * code on purpose: the provider action import graph must stay free of the
 * persist / judge chain (which itself imports the provider dispatch).
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
  /** "imap.naver.com:993" — the stored form. */
  host: string;
  email: string;
  password: string;
  socketTimeout: number;
  /** Omitted = imapflow's default. Only the action path sets these. */
  connectionTimeout?: number;
  greetingTimeout?: number;
}

export function createImapClient(opts: ImapClientOptions): ImapFlow {
  const { host, port } = parseImapHost(opts.host);
  return new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user: opts.email, pass: opts.password },
    logger: false,
    socketTimeout: opts.socketTimeout,
    ...(opts.connectionTimeout !== undefined ? { connectionTimeout: opts.connectionTimeout } : {}),
    ...(opts.greetingTimeout !== undefined ? { greetingTimeout: opts.greetingTimeout } : {}),
  });
}

export type ImapRowRejection =
  | "missing-credentials"
  | "host-not-allowlisted"
  | "host-provider-mismatch";

/**
 * Why a stored row must not be connected, or null when it may be.
 *
 * Re-validates at the connection boundary, not only at the /connect write: a
 * host that reaches a row by any other path must never open a TLS connection
 * to an internal target, nor connect a NAVER row to the iCloud host (or vice
 * versa). A row without credentials is half-migrated or hand-edited and rots
 * visibly instead of throwing.
 */
export function rejectImapRow(
  row: {
    email: string | null;
    imapHost: string | null;
    imapPasswordCipher: string | null;
  },
  provider: ImapProviderConfig,
): ImapRowRejection | null {
  if (!row.email || !row.imapHost || !row.imapPasswordCipher) return "missing-credentials";
  if (!isAllowedImapHost(row.imapHost)) return "host-not-allowlisted";
  if (!hostMatchesProvider(row.imapHost, provider)) return "host-provider-mismatch";
  return null;
}
