/**
 * Provider dispatch for mail actions (Phase 1 of
 * docs/providers/multi-provider-plan.md).
 *
 * `mailActionsFor` answers "which action surface does this message's mailbox
 * have?" from a linked-inbox id: the primary inbox (null id) is always the
 * Google OAuth account, a linked row dispatches on its `provider` column, and
 * a missing row deliberately resolves to GOOGLE — the caller then follows its
 * normal not-connected path, which is the right behavior for a stale id.
 * (This subsumes the Phase 0b `isNonGoogleLinkedInbox` helper.)
 *
 * Callers that already hold the provider (e.g. from a joined row) skip the
 * lookup with `mailActionsForProvider`.
 */

import { imapActionsEnabled } from "../../config.js";
import { prisma } from "../../db.js";
import { enabledImapProviderKeys } from "../imap-providers.js";
import type { InboxProviderName } from "../inbox-credentials.js";
import { googleMailActions } from "./google.js";
import { imapMailActions } from "./imap.js";
import { outlookMailActions } from "./outlook.js";
import type { MailProviderActions } from "./types.js";
import { unsupportedMailActions } from "./unsupported.js";

const ACTIONS_BY_PROVIDER: Readonly<Record<InboxProviderName, MailProviderActions>> = {
  GOOGLE: googleMailActions,
  NAVER: unsupportedMailActions("NAVER"),
  ICLOUD: unsupportedMailActions("ICLOUD"),
  // Phase 3C: real Graph-backed actions. Reachable only for OUTLOOK rows,
  // which can only exist once OUTLOOK_INBOX_ENABLED let a user link one.
  OUTLOOK: outlookMailActions,
  IMAP: unsupportedMailActions("IMAP"),
};

// Step B1: read/unread/star over IMAP flags for NAVER and ICLOUD, reachable only
// while IMAP_ACTIONS_ENABLED is on. Generic IMAP has no entry on purpose — it
// stays unsupported until its SSRF design (Phase 4 / B4) passes review.
const IMAP_FLAG_ACTIONS_BY_PROVIDER: Readonly<
  Partial<Record<InboxProviderName, MailProviderActions>>
> = {
  NAVER: imapMailActions("NAVER"),
  ICLOUD: imapMailActions("ICLOUD"),
};

function imapFlagActionsFor(provider: InboxProviderName): MailProviderActions | undefined {
  if (!imapActionsEnabled()) return undefined;
  // ICLOUD stays dark until ICLOUD_INBOX_ENABLED (the CASA surface freeze): its
  // poll never selects ICLOUD rows and its routes 404 while that flag is off,
  // and IMAP_ACTIONS_ENABLED must not open a door the freeze keeps shut.
  const enabledProviders: readonly string[] = enabledImapProviderKeys();
  if (!enabledProviders.includes(provider)) return undefined;
  return IMAP_FLAG_ACTIONS_BY_PROVIDER[provider];
}

export function mailActionsForProvider(provider: InboxProviderName): MailProviderActions {
  // Both flags are read per call (request time), so flipping either needs no
  // restart; with them off this returns the same unsupported object as before B1.
  return imapFlagActionsFor(provider) ?? ACTIONS_BY_PROVIDER[provider];
}

export async function mailActionsFor(
  userId: string,
  linkedInboxAccountId: string | null | undefined,
): Promise<MailProviderActions> {
  if (!linkedInboxAccountId) return googleMailActions;
  const row = await prisma.linkedInboxAccount.findFirst({
    where: { id: linkedInboxAccountId, userId },
    select: { provider: true },
  });
  return mailActionsForProvider((row?.provider as InboxProviderName) ?? "GOOGLE");
}
