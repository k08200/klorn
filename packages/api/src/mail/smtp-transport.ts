/**
 * The one place an SMTP transport is built (step B3 of
 * docs/providers/unified-platform-plan.md).
 *
 * Host, port and TLS mode come from the provider registry entry
 * (`imap-providers.ts`, with the provider help page each value came from) and
 * from nothing else: no account row, no request, no environment variable can
 * redirect the connection. The caller chooses the provider; this module only
 * turns that entry plus the account's own credentials into transport options.
 *
 * Security posture, each line pinned by smtp-transport.test.ts:
 *   - certificate verification on (`rejectUnauthorized`), TLS 1.2 or newer, the
 *     SNI name fixed to the registry host;
 *   - STARTTLS is REQUIRED where the registry says so (`requireTLS`): a server
 *     that does not offer the upgrade fails the send, the credential never
 *     crosses in clear;
 *   - every timeout is explicit: a user is waiting on the route, and
 *     nodemailer's defaults (2 min connection, 10 min socket) are far too long;
 *   - nothing is logged: SMTP traffic carries the password and the message;
 *   - content cannot pull in local files or URLs (`disableFileAccess`,
 *     `disableUrlAccess`); the sender hands over finished MIME bytes anyway.
 */

import {
  createTransport,
  type SMTPSentMessageInfo,
  type SMTPTransportOptions,
  type Transporter,
} from "nodemailer";

import type { ImapProviderConfig } from "./imap-providers.js";

export const SMTP_CONNECTION_TIMEOUT_MS = 10_000;
export const SMTP_GREETING_TIMEOUT_MS = 10_000;
/** Inactivity limit on the open socket. Covers the DATA phase of a message with attachments. */
export const SMTP_SOCKET_TIMEOUT_MS = 30_000;
export const SMTP_DNS_TIMEOUT_MS = 10_000;

const MIN_TLS_VERSION = "TLSv1.2";

/** Reply codes that mean the server refused the LOGIN itself (RFC 4954). */
const AUTH_REJECTION_REPLY_CODES: readonly number[] = [530, 534, 535];

export interface SmtpCredentials {
  email: string;
  password: string;
}

export function smtpTransportOptions(
  provider: ImapProviderConfig,
  credentials: SmtpCredentials,
): SMTPTransportOptions {
  const { host, port, security } = provider.smtp;
  return {
    host,
    port,
    secure: security === "implicit-tls",
    requireTLS: security === "starttls",
    auth: { user: credentials.email, pass: credentials.password },
    tls: { rejectUnauthorized: true, servername: host, minVersion: MIN_TLS_VERSION },
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
    dnsTimeout: SMTP_DNS_TIMEOUT_MS,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

export function createSmtpTransport(
  provider: ImapProviderConfig,
  credentials: SmtpCredentials,
): Transporter<SMTPSentMessageInfo> {
  return createTransport(smtpTransportOptions(provider, credentials));
}

/**
 * Did the server refuse the login (as opposed to a transport, recipient or
 * message problem)? nodemailer tags a failed AUTH as `code: "EAUTH"` with the
 * server's reply code; "missing credentials" and protocol hiccups carry no
 * reply code and are not a rejected password.
 */
export function isSmtpAuthRejection(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, responseCode } = err as { code?: unknown; responseCode?: unknown };
  return (
    code === "EAUTH" &&
    typeof responseCode === "number" &&
    AUTH_REJECTION_REPLY_CODES.includes(responseCode)
  );
}
