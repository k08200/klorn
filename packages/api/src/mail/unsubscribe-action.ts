/**
 * Act on one stored mail's List-Unsubscribe targets, most automatic first:
 * RFC 8058 one-click POST (server-side, SSRF-guarded in ./list-unsubscribe),
 * else a mailto send from the user's own account — the account the mail came
 * in through, never assumed to be the primary — else the browser link handed
 * back for the user to open.
 *
 * Shared by POST /api/email/:id/unsubscribe and the Subscriptions page's
 * per-sender unsubscribe. User-initiated only: the flag-gated automatic path
 * (AUTO_UNSUBSCRIBE_ENABLED) is separate and one-click-only.
 */

import type { EmailUnsubscribeResponse } from "@klorn/contract";
import { executeOneClickUnsubscribe, parseMailtoTarget } from "./list-unsubscribe.js";
import { mailActionsFor } from "./providers/dispatch.js";

/** The stored columns the action reads. */
export interface UnsubscribableEmail {
  linkedInboxAccountId: string | null;
  listUnsubscribeMailto: string | null;
  listUnsubscribeUrl: string | null;
  listUnsubscribeOneClick: boolean;
}

export type UnsubscribeOutcome =
  | { ok: true; body: EmailUnsubscribeResponse }
  | { ok: false; statusCode: 400 | 502; error: string };

export const NO_UNSUBSCRIBE_INFO = "This email has no unsubscribe information.";
export const UNSUBSCRIBE_FAILED = "Could not unsubscribe automatically.";

export async function unsubscribeFromEmail(
  userId: string,
  email: UnsubscribableEmail,
): Promise<UnsubscribeOutcome> {
  const url = email.listUnsubscribeUrl;
  const mailto = email.listUnsubscribeMailto;
  if (!url && !mailto) return { ok: false, statusCode: 400, error: NO_UNSUBSCRIBE_INFO };

  if (email.listUnsubscribeOneClick && url) {
    const result = await executeOneClickUnsubscribe(url);
    if (result.ok) return { ok: true, body: { method: "one-click", done: true } };
    // Fall through: the list's POST endpoint being down must not strand
    // the user when a mailto or link target also exists.
  }

  if (mailto) {
    const target = parseMailtoTarget(mailto);
    if (target) {
      const actions = await mailActionsFor(userId, email.linkedInboxAccountId);
      const result = await actions.sendEmail(userId, target.to, target.subject, target.body, [], {
        linkedInboxAccountId: email.linkedInboxAccountId,
      });
      if (!("unsupported" in result) && !("error" in result)) {
        return { ok: true, body: { method: "mailto", done: true } };
      }
    }
  }

  if (url) return { ok: true, body: { method: "link", done: false, url } };
  return { ok: false, statusCode: 502, error: UNSUBSCRIBE_FAILED };
}
