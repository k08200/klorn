/**
 * The connect route's credential check for a generic host (step B4, design D5 in
 * docs/providers/unified-platform-plan.md). It runs the same verify handshake as
 * every IMAP provider (imap-sync.ts: LOGIN, then open INBOX) through the pinned
 * connection, and collapses what comes back:
 *
 *   - a rejected LOGIN keeps the provider's own hint: it needs a verified TLS
 *     session and an IMAP greeting first, and the user has to fix the password;
 *   - EVERYTHING else (DNS failure, a blocked or mixed answer, refused, timeout, TLS
 *     or certificate failure, no greeting, a host the grammar refuses) becomes one
 *     message, so the endpoint is no oracle for what is reachable from Klorn's
 *     network. The real text is logged on the server only, as one capped line
 *     (log-text.ts): it came from a server the user chose and could otherwise forge
 *     log lines.
 *
 * Kept out of imap-sync.ts on purpose: that file's error text (it quotes the host
 * and the library's message) is right for fixed providers and wrong for a host the
 * user chose, and another change is editing that file.
 */

import { verifyImapCredentials } from "./imap-sync.js";
import { sanitizeLogText } from "./log-text.js";

type VerifyArgs = Parameters<typeof verifyImapCredentials>[0];
type VerifyResult = Awaited<ReturnType<typeof verifyImapCredentials>>;

export const GENERIC_CONNECT_FAILURE = "Could not connect securely to that server.";

const GENERIC_FAILURE: VerifyResult = { ok: false, message: GENERIC_CONNECT_FAILURE };

export async function verifyGenericImapCredentials(args: VerifyArgs): Promise<VerifyResult> {
  const { logScope, authFailureHint } = args.provider;
  try {
    const result = await verifyImapCredentials(args);
    if (result.ok) return result;
    if (result.message === authFailureHint) return result;
    // The text comes from a server the user chose: one capped line, never raw.
    console.warn(
      `[${logScope}] connect verification failed: ${sanitizeLogText(result.message ?? "no message")}`,
    );
    return GENERIC_FAILURE;
  } catch (err) {
    console.warn(`[${logScope}] connect verification threw: ${sanitizeLogText(err)}`);
    return GENERIC_FAILURE;
  }
}
