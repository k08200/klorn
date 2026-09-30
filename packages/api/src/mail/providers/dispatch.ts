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

import { imapActionsEnabled, imapMoveActionsEnabled, imapSendEnabled } from "../../config.js";
import { prisma } from "../../db.js";
import { enabledImapProviderKeys } from "../imap-providers.js";
import type { InboxProviderName } from "../inbox-credentials.js";
import { googleMailActions } from "./google.js";
import { imapMailActions } from "./imap.js";
import { imapMoveActions, type MoveSurface } from "./imap-moves.js";
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

// The three opt-in action sets for NAVER and ICLOUD, each behind its own OFF flag
// and independent of the others:
//   - step B1, IMAP_ACTIONS_ENABLED: read/unread/star over IMAP flags;
//   - step B2, IMAP_MOVE_ACTIONS_ENABLED: archive, trash and their undo over MOVE;
//   - step B3, IMAP_SEND_ENABLED: send, drafts and reply headers over SMTP/IMAP.
// Generic IMAP has no entry on purpose — it stays unsupported until its SSRF
// design (Phase 4 / B4) passes review. Every combination is built once, on first
// use, so each call returns the same object and, with every flag off, the
// unchanged unsupported one.
const IMAP_PROVIDER_KEYS = ["NAVER", "ICLOUD"] as const;
type ImapKey = (typeof IMAP_PROVIDER_KEYS)[number];
// imap-send.ts does not export its surface type (another change edits that file).
type SendSurface = ReturnType<typeof imapSendActions>;

interface ImapFlagSet {
  actions: boolean;
  moves: boolean;
  send: boolean;
}

const IMAP_PARTS = Object.fromEntries(
  IMAP_PROVIDER_KEYS.map((key) => [
    key,
    { flags: imapMailActions(key), moves: imapMoveActions(key), send: imapSendActions(key) },
  ]),
) as Record<ImapKey, { flags: MailProviderActions; moves: MoveSurface; send: SendSurface }>;

const COMPOSED = new Map<string, MailProviderActions>();

/** The surface for one provider under one combination of the three flags (at least one is on). */
function composeImapActions(provider: ImapKey, on: ImapFlagSet): MailProviderActions {
  const cacheKey = `${provider}:${Number(on.actions)}${Number(on.moves)}${Number(on.send)}`;
  const cached = COMPOSED.get(cacheKey);
  if (cached) return cached;
  const parts = IMAP_PARTS[provider];
  // Each part overrides only its own actions, over a base that is either the B1
  // set (which is the unsupported stubs plus read/star) or the stubs alone.
  const composed: MailProviderActions = {
    ...(on.actions ? parts.flags : unsupportedMailActions(provider)),
    ...(on.moves ? parts.moves : {}),
    ...(on.send ? parts.send : {}),
  };
  COMPOSED.set(cacheKey, composed);
  return composed;
}

function isImapKey(provider: InboxProviderName): provider is ImapKey {
  return (IMAP_PROVIDER_KEYS as readonly string[]).includes(provider);
}

function imapActionsFor(provider: InboxProviderName): MailProviderActions | undefined {
  if (!isImapKey(provider)) return undefined;
  // ICLOUD stays dark until ICLOUD_INBOX_ENABLED (the CASA surface freeze): its
  // poll never selects ICLOUD rows and its routes 404 while that flag is off,
  // and no action flag may open a door the freeze keeps shut.
  const enabledProviders: readonly string[] = enabledImapProviderKeys();
  if (!enabledProviders.includes(provider)) return undefined;
  const on = {
    actions: imapActionsEnabled(),
    moves: imapMoveActionsEnabled(),
    send: imapSendEnabled(),
  };
  if (!on.actions && !on.moves && !on.send) return undefined;
  return composeImapActions(provider, on);
}

export function mailActionsForProvider(provider: InboxProviderName): MailProviderActions {
  // The flags are read per call (request time), so flipping any needs no
  // restart; with all off this returns the same unsupported object as before B1.
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
