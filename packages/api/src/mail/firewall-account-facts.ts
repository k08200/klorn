/**
 * The account, read state and attachment flag a firewall item's mail preview
 * carries (`FirewallEmailContext.source` / `.unread` / `.hasAttachment`).
 *
 * Pure: the route fetches, this maps. Every answer is a recorded fact or null
 * — a row whose account cannot be named shows no badge, never a guess.
 */

import type { FirewallEmailContext, FirewallSourceWire, InboxProvider } from "@klorn/contract";
import type { Prisma } from "@prisma/client";

/** A linked account as the badge needs it. */
export interface LinkedAccountFact {
  provider: InboxProvider;
  email: string;
}

/**
 * What the mail lookup must select for `accountFactsOf`. Spread into the
 * route's existing EmailMessage selects, so the facts cost no extra query.
 *
 * The count leaves out inline images (an image part with a Content-ID is one
 * the body shows, typically a signature logo): counting them would put the
 * attachment glyph on most mail.
 */
export const accountFactsSelect = {
  isRead: true,
  linkedInboxAccountId: true,
  _count: {
    select: {
      attachments: {
        where: { NOT: { contentId: { not: null }, mimeType: { startsWith: "image/" } } },
      },
    },
  },
} satisfies Prisma.EmailMessageSelect;

export interface AccountFactsRow {
  linkedInboxAccountId: string | null;
  isRead?: boolean | null;
  _count?: { attachments: number } | null;
}

export interface AccountFactsContext {
  /** The signed-in user's own address: the primary account's label. */
  primaryEmail: string | null;
  /** Linked accounts by id; null when the lookup failed. */
  linked: ReadonlyMap<string, LinkedAccountFact> | null;
}

/**
 * The account a mail is on. A null `linkedInboxAccountId` is the primary
 * account, which is Google by construction (EmailMessage, schema.prisma).
 */
export function firewallSourceOf(
  linkedInboxAccountId: string | null,
  context: AccountFactsContext,
): FirewallSourceWire | null {
  if (linkedInboxAccountId === null) {
    const label = context.primaryEmail?.trim();
    return label ? { provider: "GOOGLE", accountId: null, label } : null;
  }
  const account = context.linked?.get(linkedInboxAccountId);
  if (!account) return null;
  return { provider: account.provider, accountId: linkedInboxAccountId, label: account.email };
}

/** The three preview fields. A missing column or count is "no claim" (null). */
export function accountFactsOf(
  row: AccountFactsRow,
  context: AccountFactsContext,
): Pick<FirewallEmailContext, "source" | "unread" | "hasAttachment"> {
  return {
    source: firewallSourceOf(row.linkedInboxAccountId, context),
    unread: typeof row.isRead === "boolean" ? !row.isRead : null,
    hasAttachment: row._count ? row._count.attachments > 0 : null,
  };
}
