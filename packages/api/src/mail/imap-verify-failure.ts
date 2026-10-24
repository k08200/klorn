/**
 * How a failed IMAP verify (imap-sync.ts verifyImapCredentials) is answered.
 *
 * The client only ever gets a static sentence plus a stable code. The library's
 * own text never leaves the server: it can name internal addresses, quote the
 * server's reply, or (in principle) echo the command that failed. That text is
 * logged here instead, as one capped line with the password masked out.
 */

import type { ImapProviderConfig } from "./imap-providers.js";
import { sanitizeLogText } from "./log-text.js";
import { isImapAuthFailure } from "./providers/imap-session.js";

/**
 * Machine-readable reason a verify failed, for clients that localize the message
 * (the macOS connect sheet, the web settings sections).
 */
export type VerifyFailureCode = "IMAP_AUTH_FAILED" | "IMAP_UNREACHABLE" | "IMAP_VERIFY_FAILED";

export interface VerifyFailure {
  ok: false;
  message: string;
  code: VerifyFailureCode;
}

export const IMAP_UNREACHABLE_MESSAGE = (host: string): string =>
  `Could not reach ${host}. Check your connection and try again.`;

export const IMAP_VERIFY_FAILED_MESSAGE = "Could not verify this mailbox. Try again later.";

/**
 * Socket-level failures: Node's errnos plus imapflow's own codes for a socket
 * that timed out, never greeted, failed to upgrade, or dropped.
 */
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEOUT",
  "GREETING_TIMEOUT",
  "UPGRADE_TIMEOUT",
  "NoConnection",
  "EConnectionClosed",
]);

/** The same failures when only the text carries them (a wrapped or re-thrown error). */
const NETWORK_ERROR_TEXT =
  /\b(?:ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH)\b|timeout|failed to receive greeting/i;

const REDACTED = "[redacted]";

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isNetworkFailure(err: unknown, text: string): boolean {
  const code = errorCode(err);
  return (code !== undefined && NETWORK_ERROR_CODES.has(code)) || NETWORK_ERROR_TEXT.test(text);
}

function isAuthFailure(err: unknown, text: string): boolean {
  // imapflow reports a rejected LOGIN as Error("Command failed") with
  // `authenticationFailed` set, so the flag — not the text — is the real signal.
  return isImapAuthFailure(err) || /authentication failed/i.test(text) || /AUTH=/i.test(text);
}

/**
 * Only the code and the message are logged — never the error object, whose
 * fields (response, command) are where a library would carry what was sent.
 */
function logVerifyFailure(provider: ImapProviderConfig, err: unknown, password: string): void {
  const raw = `${errorCode(err) ?? "no-code"}: ${errorText(err)}`;
  const masked = password ? raw.split(password).join(REDACTED) : raw;
  console.warn(`[${provider.logScope}] connect verification failed: ${sanitizeLogText(masked)}`);
}

export function classifyVerifyFailure(
  err: unknown,
  args: { provider: ImapProviderConfig; host: string; password: string },
): VerifyFailure {
  const text = errorText(err);
  if (isAuthFailure(err, text)) {
    return { ok: false, message: args.provider.authFailureHint, code: "IMAP_AUTH_FAILED" };
  }
  logVerifyFailure(args.provider, err, args.password);
  if (isNetworkFailure(err, text)) {
    return { ok: false, message: IMAP_UNREACHABLE_MESSAGE(args.host), code: "IMAP_UNREACHABLE" };
  }
  return { ok: false, message: IMAP_VERIFY_FAILED_MESSAGE, code: "IMAP_VERIFY_FAILED" };
}
