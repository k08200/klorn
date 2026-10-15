/**
 * The one billing rule for connecting a mailbox (founder decision 2026-10-15,
 * LOCKED): a user's FIRST mail account is free, whatever the provider (Google,
 * iCloud, Naver, Outlook, generic IMAP). Connecting a SECOND one needs the
 * `multi_account` feature (Pro). Every connect route asks here; nothing else
 * decides it.
 *
 * What counts as an existing source: the primary Google token, or ANY
 * LinkedInboxAccount row — including one marked needsReconnect. Counting only
 * working rows would let a Free user hold two mailboxes by rotation (connect A,
 * let A break, connect B, then "repair" A). The repair case is handled the
 * other way: the account being (re)connected is identified by its
 * (provider, email) key and never counts against itself, so a user can always
 * re-verify their own mailbox. To switch mailboxes on Free, disconnect first.
 *
 * Race: the check runs before the write, and again after a NEW row was
 * inserted (keepIfOnlyMailSource). The second check fails closed: if any other
 * source exists by then, the new row is removed. Two parallel first connects of
 * different accounts can therefore at worst both be refused (the user retries
 * one), never both kept.
 *
 * Sign-in with Google stores the primary token through the sign-in flow, which
 * is not gated here.
 *
 * PAYWALL_ENABLED off: everything is allowed, before any DB read.
 */

import type { InboxProvider } from "@prisma/client";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getUserId } from "../auth.js";
import { PAYWALL_ENABLED } from "../config.js";
import { prisma } from "../db.js";
import { hasAnyMailSource } from "../mail/mail-source.js";
import { planHasFeature } from "./stripe.js";

export interface MailAccountKey {
  provider: InboxProvider;
  email: string;
}

/** The 403 body every refused connect sends. `code` is what the clients match on. */
export const SECOND_MAIL_ACCOUNT_REFUSAL = {
  error: "Connecting a second mail account is a Pro feature.",
  code: "ENTITLEMENT_REQUIRED",
} as const;

async function hasMultiAccount(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { plan: true, role: true },
  });
  return planHasFeature(user?.plan ?? "FREE", "multi_account", user?.role ?? undefined);
}

type Excluding = { account: MailAccountKey } | { provider: InboxProvider };

/** Any mail source other than the excluded account (or provider)? Scoped by userId. */
async function hasOtherMailSource(userId: string, excluding: Excluding): Promise<boolean> {
  const notExcluded =
    "account" in excluding
      ? { NOT: { provider: excluding.account.provider, email: excluding.account.email } }
      : { provider: { not: excluding.provider } };
  const [googleToken, otherLinked] = await Promise.all([
    prisma.userToken.findFirst({
      where: { userId, provider: "google" },
      select: { id: true },
    }),
    prisma.linkedInboxAccount.findFirst({
      where: { userId, ...notExcluded },
      select: { id: true },
    }),
  ]);
  return googleToken !== null || otherLinked !== null;
}

/** May this user connect (or re-connect) exactly this account? */
export async function mayConnectMailAccount(
  userId: string,
  account: MailAccountKey,
): Promise<boolean> {
  if (!PAYWALL_ENABLED) return true;
  if (await hasMultiAccount(userId)) return true;
  return !(await hasOtherMailSource(userId, { account }));
}

/**
 * OAuth start, where the address is not known yet: ignore this provider's rows
 * (the user may be re-linking one of them). The callback then runs
 * mayConnectMailAccount with the real address, so this is only a pre-filter.
 */
export async function mayStartMailLink(userId: string, provider: InboxProvider): Promise<boolean> {
  if (!PAYWALL_ENABLED) return true;
  if (await hasMultiAccount(userId)) return true;
  return !(await hasOtherMailSource(userId, { provider }));
}

/**
 * Check-after-insert for a row this request just CREATED. Returns false (and
 * deletes the row, scoped to the user) when a Free user now has another source,
 * e.g. a parallel first connect that committed meanwhile.
 */
export async function keepIfOnlyMailSource(
  userId: string,
  saved: MailAccountKey & { id: string },
): Promise<boolean> {
  if (await mayConnectMailAccount(userId, saved)) return true;
  await prisma.linkedInboxAccount.deleteMany({ where: { id: saved.id, userId } });
  return false;
}

/**
 * The primary Google slot (POST /google/start and its integration callback) is
 * one per user: an existing primary token is the same slot being repaired or
 * replaced, never "another" source. So on Free it only needs no linked row.
 */
export async function mayConnectPrimaryGoogle(userId: string): Promise<boolean> {
  if (!PAYWALL_ENABLED) return true;
  if (await hasMultiAccount(userId)) return true;
  const linked = await prisma.linkedInboxAccount.findFirst({
    where: { userId },
    select: { id: true },
  });
  return linked === null;
}

/**
 * Check-after-write for a primary token this request just CREATED. Fails
 * closed like keepIfOnlyMailSource: a Free user who now also has a linked row
 * loses the new token. Only call it when no token existed before the write.
 */
export async function keepPrimaryGoogleIfOnlyMailSource(userId: string): Promise<boolean> {
  if (await mayConnectPrimaryGoogle(userId)) return true;
  await prisma.userToken.deleteMany({ where: { userId, provider: "google" } });
  return false;
}

/**
 * The one linked inbox a user WITHOUT multi_account may sync: their first
 * mailbox, when it is a linked row (no primary Google token). Null when the
 * primary Google inbox is the first mailbox, or there is none.
 */
export async function firstLinkedMailSourceId(userId: string): Promise<string | null> {
  const [googleToken, oldest] = await Promise.all([
    prisma.userToken.findFirst({
      where: { userId, provider: "google" },
      select: { id: true },
    }),
    prisma.linkedInboxAccount.findFirst({
      where: { userId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    }),
  ]);
  if (googleToken) return null;
  return oldest?.id ?? null;
}

/**
 * Which linked inboxes a sync pass may touch: all of them with multi_account,
 * otherwise only the user's first mailbox (firstLinkedMailSourceId), if any.
 */
export function linkedInboxesToSync<T extends { id: string }>(
  inboxes: readonly T[],
  multiAccount: boolean,
  firstLinkedId: string | null,
): T[] {
  if (multiAccount) return [...inboxes];
  return firstLinkedId ? inboxes.filter((inbox) => inbox.id === firstLinkedId) : [];
}

/** For the settings UI: may this user connect a NEW mail account right now? */
export async function canConnectNewMailAccount(userId: string): Promise<boolean> {
  if (!PAYWALL_ENABLED) return true;
  if (await hasMultiAccount(userId)) return true;
  return !(await hasAnyMailSource(userId));
}

/**
 * preHandler for an OAuth link START (run after requireAuth): 403 with the
 * second-account refusal when this user could not finish the link anyway.
 */
export function requireMailLinkStart(provider: InboxProvider) {
  return async function mailLinkStartGuard(request: FastifyRequest, reply: FastifyReply) {
    if (!(await mayStartMailLink(getUserId(request), provider))) {
      return reply.code(403).send(SECOND_MAIL_ACCOUNT_REFUSAL);
    }
  };
}
