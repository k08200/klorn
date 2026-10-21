/**
 * Which LINKED Google inboxes a sync pass may touch, under the same billing
 * rule as connecting them (mail-account-entitlement.ts): the first mail
 * account is free, more than one needs `multi_account`.
 *
 * - PAYWALL_ENABLED off: every linked inbox, like every connect is allowed.
 * - multi_account (Pro/Team/Enterprise/ADMIN): every linked inbox.
 * - Otherwise: only the user's FIRST mailbox, and only when it is a linked row
 *   (no primary Google token). A Free user whose first mailbox is the primary
 *   Gmail syncs no linked inbox.
 *
 * Linked Google sync of any kind also stays behind MULTI_INBOX_SYNC_ENABLED;
 * callers check that flag first.
 */

import { PAYWALL_ENABLED } from "../config.js";
import { prisma } from "../db.js";
import { NOT_KLORN_ADDRESS } from "../mail/klorn-mailbox.js";
import { planHasFeature } from "./stripe.js";

/** True when every linked inbox may sync (paywall off, or multi_account). */
export function syncsEveryLinkedInbox(plan: string, role?: string | null): boolean {
  return !PAYWALL_ENABLED || planHasFeature(plan, "multi_account", role ?? undefined);
}

/**
 * The user's first mailbox when it is a linked row: the oldest row, and only
 * when there is no primary Google token. Null otherwise.
 */
export async function firstLinkedMailSourceId(userId: string): Promise<string | null> {
  const [googleToken, oldest] = await Promise.all([
    prisma.userToken.findFirst({
      where: { userId, provider: "google" },
      select: { id: true },
    }),
    prisma.linkedInboxAccount.findFirst({
      where: { userId, ...NOT_KLORN_ADDRESS },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    }),
  ]);
  if (googleToken) return null;
  return oldest?.id ?? null;
}

/** Narrow a list of linked inboxes to the ones this pass may sync. */
export function linkedInboxesToSync<T extends { id: string }>(
  inboxes: readonly T[],
  everyInbox: boolean,
  firstLinkedId: string | null,
): T[] {
  if (everyInbox) return [...inboxes];
  return firstLinkedId ? inboxes.filter((inbox) => inbox.id === firstLinkedId) : [];
}

/** The linked inboxes `userId` may sync now, given their plan. */
export async function scopeLinkedInboxes<T extends { id: string }>(
  userId: string,
  plan: string,
  role: string | null | undefined,
  inboxes: readonly T[],
): Promise<T[]> {
  if (syncsEveryLinkedInbox(plan, role)) return [...inboxes];
  if (inboxes.length === 0) return [];
  return linkedInboxesToSync(inboxes, false, await firstLinkedMailSourceId(userId));
}
