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
 *   - the socket is the caller's (an unconnected net.Socket nodemailer connects to
 *     the registry host), so an abort can really destroy the connection; see
 *     `openSmtpSession`;
 *   - content cannot pull in local files or URLs (`disableFileAccess`,
 *     `disableUrlAccess`); the sender hands over finished MIME bytes anyway;
 *   - EHLO carries a fixed name (`klorn.ai`), not the machine's hostname, which
 *     would otherwise be sent to the provider with every message.
 *
 * nodemailer is imported when the first transport is built, not at boot: while
 * IMAP_SEND_ENABLED is off the package never loads.
 */

import net from "node:net";

import type { SMTPSentMessageInfo, SMTPTransportOptions, Transporter } from "nodemailer";

import type { ImapProviderConfig } from "./imap-providers.js";

export const SMTP_CONNECTION_TIMEOUT_MS = 10_000;
export const SMTP_GREETING_TIMEOUT_MS = 10_000;
/** Inactivity limit on the open socket. Covers the DATA phase of a message with attachments. */
export const SMTP_SOCKET_TIMEOUT_MS = 30_000;
export const SMTP_DNS_TIMEOUT_MS = 10_000;

const MIN_TLS_VERSION = "TLSv1.2";

/** What the client says in EHLO. A fixed string: nodemailer's default is os.hostname(). */
export const SMTP_EHLO_NAME = "klorn.ai";

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
  if (provider.smtp === null) {
    // Generic IMAP has no outgoing server (step B4): fail closed rather than connect anywhere.
    throw new Error(`${provider.label} has no SMTP endpoint`);
  }
  const { host, port, security } = provider.smtp;
  return {
    host,
    port,
    secure: security === "implicit-tls",
    requireTLS: security === "starttls",
    name: SMTP_EHLO_NAME,
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

type NodemailerModule = typeof import("nodemailer");

let nodemailerLoad: Promise<NodemailerModule> | undefined;

/**
 * The nodemailer module, imported on first use. Concurrent first callers share
 * one import; a failed import is forgotten so the next send can retry it.
 */
function loadNodemailer(): Promise<NodemailerModule> {
  nodemailerLoad ??= import("nodemailer").catch((err: unknown) => {
    nodemailerLoad = undefined;
    throw err;
  });
  return nodemailerLoad;
}

/**
 * A transport for one send. `socket`, when given, is the unconnected socket
 * nodemailer will connect and use (its documented `socket` option), so the caller
 * holds the one handle that can really close the connection.
 */
export async function createSmtpTransport(
  provider: ImapProviderConfig,
  credentials: SmtpCredentials,
  socket?: net.Socket,
): Promise<Transporter<SMTPSentMessageInfo>> {
  const { createTransport } = await loadNodemailer();
  return createTransport({
    ...smtpTransportOptions(provider, credentials),
    ...(socket ? { socket } : {}),
  });
}

/**
 * Submit finished MIME bytes with an explicit envelope. `raw` goes out as given
 * (dot-stuffed, nothing added); the envelope is never derived from the message.
 */
export function sendRaw(
  transport: Transporter<SMTPSentMessageInfo>,
  message: { from: string; to: string; raw: Buffer },
): Promise<SMTPSentMessageInfo> {
  return transport.sendMail({
    envelope: { from: message.from, to: [message.to] },
    raw: message.raw,
  });
}

/**
 * One SMTP submission that the caller can really stop.
 *
 * nodemailer's `transport.close()` does not close a connection that is in flight
 * (for the non-pooled transport it only emits an event), and even the connection's
 * own close() only half-closes the socket, which a stalled server never answers.
 * So the session creates the socket itself, hands it to nodemailer, and `abort()`
 * DESTROYS it: a message that was not acknowledged before an abort cannot be
 * acknowledged, or delivered, after it.
 *
 * `connected` says whether the TCP connection was ever established. That is the
 * one thing the sender knows that nodemailer's error does not say: a stall after
 * DATA and a connect timeout both surface as `ETIMEDOUT command=CONN`.
 */
export interface SmtpSession {
  send(message: { from: string; to: string; raw: Buffer }): Promise<SMTPSentMessageInfo>;
  readonly connected: boolean;
  /** Destroy the socket and close the transport. Safe to call more than once. */
  abort(): void;
  /** End the transport after a finished send. Leaves the socket to nodemailer. */
  close(): void;
}

export async function openSmtpSession(
  provider: ImapProviderConfig,
  credentials: SmtpCredentials,
): Promise<SmtpSession> {
  const socket = new net.Socket();
  let aborted = false;
  let connected = false;
  // nodemailer resolves the hostname FIRST and only then calls socket.connect().
  // destroy() on a socket that has not connected yet is undone by that connect()
  // (Node reconnects a destroyed socket), so an abort during the DNS lookup, which
  // can last up to the task deadline, would still deliver the message. Once
  // aborted the socket refuses to connect; nodemailer wraps the call in a
  // try/catch and reports the throw as a connection error.
  const connect = socket.connect.bind(socket) as (...args: unknown[]) => net.Socket;
  socket.connect = ((...args: unknown[]) => {
    if (aborted) throw new Error("SMTP session aborted before it connected");
    return connect(...args);
  }) as typeof socket.connect;
  socket.once("connect", () => {
    connected = true;
    // belt and braces: a connect that was already in flight when the abort came
    if (aborted) socket.destroy();
  });
  let transport: Transporter<SMTPSentMessageInfo>;
  try {
    transport = await createSmtpTransport(provider, credentials, socket);
  } catch (err) {
    socket.destroy();
    throw err;
  }
  return {
    send: (message) => sendRaw(transport, message),
    get connected() {
      return connected;
    },
    abort() {
      aborted = true;
      socket.destroy();
      transport.close();
    },
    close() {
      transport.close();
    },
  };
}

export type SmtpFailureClass = "auth" | "refused" | "not-sent" | "unconfirmed";

/** nodemailer error codes that can only happen before any MAIL FROM was sent. */
const PRE_ENVELOPE_CODES: readonly string[] = [
  "EDNS",
  "ETLS",
  "EAUTH",
  "ENOAUTH",
  "ECONFIG",
  "EREQUIRETLS",
  "EPROXY",
];

/**
 * Node's own messages for a TLS handshake that failed or never finished. nodemailer
 * reports them as `ESOCKET` on `CONN` (it overwrites the original error code), so
 * the message is all that is left of the cause. They come from OpenSSL and the
 * socket, not from the server, and can only be produced by the handshake. A
 * message that matches none of them (a reset, a broken pipe, a timeout, an alert
 * after the handshake) proves nothing and stays "unconfirmed": the list errs
 * toward not claiming "not sent".
 */
const TLS_HANDSHAKE_FAILURE =
  /self[- ]signed certificate|unable to (?:verify the first|get local issuer) certificate|certificate (?:has expired|is not yet valid|verify failed|revoked)|does not match certificate's altnames|before secure TLS connection was established|wrong version number|unsupported protocol|no protocols available|alert handshake failure/i;

function isTlsHandshakeFailure(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  return code === "ESOCKET" && typeof message === "string" && TLS_HANDSHAKE_FAILURE.test(message);
}

/**
 * What a failed submission proves about delivery.
 *   - "auth": the server rejected the login (530, 534, 535). Nothing was sent.
 *   - "refused": the server answered no to the sender, a recipient or the message
 *     (a definite answer; the message was not accepted).
 *   - "not-sent": provably before any MAIL FROM: the connection was never
 *     established (refused, timed out, reset while connecting), DNS, TLS or
 *     STARTTLS (including a certificate or hostname failure, whose handshake
 *     precedes AUTH), any other login failure.
 *   - "unconfirmed": anything else on an established connection. SMTP cannot say
 *     whether a message whose connection died was accepted, and nodemailer reports
 *     a stall after DATA exactly like a connect timeout (`ETIMEDOUT`, command
 *     `CONN`), so the error's `command` is not evidence of anything.
 */
export function classifySmtpFailure(err: unknown, connected: boolean): SmtpFailureClass {
  if (isSmtpAuthRejection(err)) return "auth";
  const code =
    typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  if (code === "EENVELOPE" || code === "EMESSAGE") return "refused";
  if (!connected || isTlsHandshakeFailure(err)) return "not-sent";
  return typeof code === "string" && PRE_ENVELOPE_CODES.includes(code) ? "not-sent" : "unconfirmed";
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
