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

import { imapActionsEnabled, imapSendEnabled } from "../../config.js";
import { prisma } from "../../db.js";
import { enabledImapProviderKeys } from "../imap-providers.js";
import type { InboxProviderName } from "../inbox-credentials.js";
import { googleMailActions } from "./google.js";
import { imapMailActions } from "./imap.js";
import { imapSendActions } from "./imap-send.js";
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

type ImapActionTable = Readonly<Partial<Record<InboxProviderName, MailProviderActions>>>;

// The two opt-in action sets for NAVER and ICLOUD, each behind its own OFF flag:
//   - step B1, IMAP_ACTIONS_ENABLED: read/unread/star over IMAP flags;
//   - step B3, IMAP_SEND_ENABLED: send, drafts and reply headers over SMTP/IMAP.
// Generic IMAP has no entry on purpose — it stays unsupported until its SSRF
// design (Phase 4 / B4) passes review. Every combination is built once, so each
// call returns the same object and, with both flags off, the unchanged
// unsupported one.
const IMAP_PROVIDER_KEYS = ["NAVER", "ICLOUD"] as const;

const IMAP_FLAG_ACTIONS: ImapActionTable = Object.fromEntries(
  IMAP_PROVIDER_KEYS.map((key) => [key, imapMailActions(key)]),
);
const IMAP_SEND_ONLY_ACTIONS: ImapActionTable = Object.fromEntries(
  IMAP_PROVIDER_KEYS.map((key) => [
    key,
    { ...unsupportedMailActions(key), ...imapSendActions(key) },
  ]),
);
const IMAP_FLAG_AND_SEND_ACTIONS: ImapActionTable = Object.fromEntries(
  IMAP_PROVIDER_KEYS.map((key) => [key, { ...imapMailActions(key), ...imapSendActions(key) }]),
);

function imapActionsFor(provider: InboxProviderName): MailProviderActions | undefined {
  // ICLOUD stays dark until ICLOUD_INBOX_ENABLED (the CASA surface freeze): its
  // poll never selects ICLOUD rows and its routes 404 while that flag is off,
  // and neither action flag may open a door the freeze keeps shut.
  const enabledProviders: readonly string[] = enabledImapProviderKeys();
  if (!enabledProviders.includes(provider)) return undefined;
  const flags = imapActionsEnabled();
  const send = imapSendEnabled();
  if (flags && send) return IMAP_FLAG_AND_SEND_ACTIONS[provider];
  if (flags) return IMAP_FLAG_ACTIONS[provider];
  if (send) return IMAP_SEND_ONLY_ACTIONS[provider];
  return undefined;
}

export function mailActionsForProvider(provider: InboxProviderName): MailProviderActions {
  // The flags are read per call (request time), so flipping either needs no
  // restart; with both off this returns the same unsupported object as before B1.
  return imapActionsFor(provider) ?? ACTIONS_BY_PROVIDER[provider];
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
