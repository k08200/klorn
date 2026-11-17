/**
 * The way out of an IMAP provider whose flag closed after users connected it
 * (follow-up to #1756). IMAP_PRESETS_ENABLED (or ICLOUD_INBOX_ENABLED,
 * GENERIC_IMAP_ENABLED) turned off, or a cohort narrowed, used to make every
 * route of the provider answer 404, /disconnect included: a user who had
 * connected a mailbox could no longer remove it, nor the app password Klorn
 * stores for it.
 *
 * /status and /disconnect now stay open to a user who owns at least one mailbox
 * of that provider, whatever the flag (owner-exit-gate.ts). Everyone else gets
 * exactly what they got before. /connect stays dark (it keeps darkRouteGate and
 * cohortGate in routes/imap-connect.ts), and the scheduler polls no row of a
 * provider whose flag is off (imap-scheduler.ts).
 */

import { prisma } from "../db.js";
import type { ImapProviderConfig } from "../mail/imap-providers.js";
import type { OwnerExit } from "./owner-exit-gate.js";

/** Owners are users with a mailbox of this provider; scoped to their own rows. */
export function imapOwnerExit(cfg: ImapProviderConfig): OwnerExit {
  return {
    surface: `imap:${cfg.provider}`,
    owns: async (userId) =>
      (await prisma.linkedInboxAccount.findFirst({
        where: { userId, provider: cfg.provider },
        select: { id: true },
      })) !== null,
  };
}
