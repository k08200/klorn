/**
 * The Klorn address as an inbox provider (step E1a of
 * docs/providers/unified-platform-plan.md). A KLORN LinkedInboxAccount row is the
 * mailbox of the account's own Klorn address: no credentials, mail delivered by
 * the inbound webhook (E1b).
 *
 * It is part of the account, not a linked mail source: the paywall's "first
 * mailbox is free" rule and the first-mailbox sync scope leave it out (V5: the
 * mailbox is auxiliary; L7 gates sending on a subscription, not receiving). Without
 * that, a free user's address would take the free account slot. "Has any mail"
 * (mail/mail-source.ts) does count it: a Klorn-only user has mail.
 */

import type { InboxProvider } from "@prisma/client";

export const KLORN_PROVIDER: InboxProvider = "KLORN";

/** Spread into a LinkedInboxAccount filter to leave the Klorn address out. */
export const NOT_KLORN_ADDRESS = { provider: { not: KLORN_PROVIDER } };
