/**
 * The one billing rule for connecting a mailbox (founder decision 2026-10-15,
 * LOCKED): a user's FIRST mail account is free, whatever the provider (Google,
 * iCloud, Naver, Outlook, generic IMAP). Connecting a SECOND one needs the
 * `multi_account` feature (Pro). Every connect route asks here; nothing else
 * decides it.
 *
 * Only NEW accounts are gated. Re-verifying or reconnecting a row (or the
 * primary Google token) the user ALREADY owns is always allowed, so nobody is
 * ever locked out of repairing a mailbox they have — including a Free user who
 * holds several from before the paywall flipped. The key is (provider, email),
 * the email compared trimmed and case-insensitively.
 *
 * What counts as an existing source for a NEW account: the primary Google
 * token, or ANY LinkedInboxAccount row — including one marked needsReconnect.
 * Counting only working rows would let a Free user hold two mailboxes by
 * rotation (connect A, let A break, connect B). To switch mailboxes on Free,
 * disconnect first.
 *
 * Race: the check runs before the write, and again after a NEW row or token was
 * created (keepIfOnlyMailSource / keepPrimaryGoogleIfOnlyMailSource). The
 * second check fails closed — on a refusal AND on an error — by removing what
 * was just created. Two parallel first connects of different accounts can at
 * worst both be refused (the user retries one), never both kept.
 *
 * Google sign-in does not store the primary token (only the connect callback
 * does), so it is not gated here.
 *
 * PAYWALL_ENABLED off: everything is allowed, before any DB read.
 */

import type { InboxProvider } from "@prisma/client";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getUserId } from "../auth.js";
import { PAYWALL_ENABLED } from "../config.js";
import { prisma } from "../db.js";
import { KLORN_PROVIDER, NOT_KLORN_ADDRESS } from "../mail/klorn-mailbox.js";
import { captureError } from "../sentry.js";
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

/** The account key's email in the form every comparison uses. */
export function normalizeMailAccountEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** A Prisma filter matching this account's rows, email compared case-insensitively. */
function accountWhere(account: MailAccountKey) {
  return {
    provider: account.provider,
    email: { equals: normalizeMailAccountEmail(account.email), mode: "insensitive" as const },
  };
}

async function hasMultiAccount(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { plan: true, role: true },
  });
  return planHasFeature(user?.plan ?? "FREE", "multi_account", user?.role ?? undefined);
}

async function hasPrimaryGoogleToken(userId: string): Promise<boolean> {
  const token = await prisma.userToken.findFirst({
    where: { userId, provider: "google" },
    select: { id: true },
  });
  return token !== null;
}

type Excluding = { account: MailAccountKey } | { provider: InboxProvider };

/** Any mail source other than the excluded account (or provider)? Scoped by userId. */
async function hasOtherMailSource(userId: string, excluding: Excluding): Promise<boolean> {
  const notExcluded =
    "account" in excluding
      ? { NOT: accountWhere(excluding.account), ...NOT_KLORN_ADDRESS }
      : { provider: { notIn: [excluding.provider, KLORN_PROVIDER] } };
  const [primary, otherLinked] = await Promise.all([
    hasPrimaryGoogleToken(userId),
    prisma.linkedInboxAccount.findFirst({
      where: { userId, ...notExcluded },
      select: { id: true },
    }),
  ]);
  return primary || otherLinked !== null;
}

async function ownsLinkedAccount(userId: string, account: MailAccountKey): Promise<boolean> {
  const row = await prisma.linkedInboxAccount.findFirst({
    where: { userId, ...accountWhere(account) },
    select: { id: true },
  });
  return row !== null;
}

/**
 * The row this user already has for this account, or null: the exact key
 * first, then the same address in another case (a legacy mixed-case row), so a
 * re-link updates that row — keeping its stored address — instead of adding a
 * duplicate. Scoped by userId.
 */
export async function findOwnedLinkedAccount(
  userId: string,
  account: MailAccountKey,
): Promise<{ id: string; email: string } | null> {
  const select = { id: true, email: true } as const;
  const exact = await prisma.linkedInboxAccount.findUnique({
    where: {
      userId_provider_email: { userId, provider: account.provider, email: account.email },
    },
    select,
  });
  if (exact) return exact;
  return prisma.linkedInboxAccount.findFirst({
    where: { userId, ...accountWhere(account) },
    select,
  });
}

/** May this user ADD this account as a new one (ignoring rows of the same key)? */
async function mayAddMailAccount(userId: string, account: MailAccountKey): Promise<boolean> {
  if (await hasMultiAccount(userId)) return true;
  return !(await hasOtherMailSource(userId, { account }));
}

/** May this user connect (or re-connect) exactly this account? */
export async function mayConnectMailAccount(
  userId: string,
  account: MailAccountKey,
): Promise<boolean> {
  if (!PAYWALL_ENABLED) return true;
  if (await ownsLinkedAccount(userId, account)) return true; // a repair, never gated
  return mayAddMailAccount(userId, account);
}

/**
 * OAuth start, where the address is not known yet. A user who already owns a
 * row of this provider may be repairing it, and every row of this provider is
 * ignored when looking for other sources. The callback then runs
 * mayConnectMailAccount with the real address, so this is only a pre-filter.
 */
export async function mayStartMailLink(userId: string, provider: InboxProvider): Promise<boolean> {
  if (!PAYWALL_ENABLED) return true;
  if (await hasMultiAccount(userId)) return true;
  const ownsProviderRow = await prisma.linkedInboxAccount.findFirst({
    where: { userId, provider },
    select: { id: true },
  });
  if (ownsProviderRow) return true;
  return !(await hasOtherMailSource(userId, { provider }));
}

/**
 * Runs the post-write re-check and removes what was just created when it
 * refuses OR throws (fail closed). The removal itself is best effort: its own
 * failure is reported, and the answer is still a refusal.
 */
async function keepOrRollBack(
  scope: string,
  userId: string,
  allowed: () => Promise<boolean>,
  rollBack: () => Promise<unknown>,
): Promise<boolean> {
  let keep = false;
  try {
    keep = await allowed();
  } catch (err) {
    console.warn(`[MAIL-ENTITLEMENT] ${scope} re-check failed for ${userId}; rolling back:`, err);
    captureError(err, { tags: { scope: `mail-entitlement.${scope}.recheck`, userId } });
  }
  if (keep) return true;
  try {
    await rollBack();
  } catch (err) {
    console.error(`[MAIL-ENTITLEMENT] ${scope} rollback failed for ${userId}:`, err);
    captureError(err, { tags: { scope: `mail-entitlement.${scope}.rollback`, userId } });
  }
  return false;
}

/**
 * Check-after-insert for a row this request just CREATED. Returns false (and
 * deletes the row, scoped to the user) when a Free user now has another source,
 * e.g. a parallel first connect that committed meanwhile, or when the check
 * itself fails.
 */
export async function keepIfOnlyMailSource(
  userId: string,
  saved: MailAccountKey & { id: string },
): Promise<boolean> {
  if (!PAYWALL_ENABLED) return true;
  return keepOrRollBack(
    "linked",
    userId,
    () => mayAddMailAccount(userId, saved),
    () => prisma.linkedInboxAccount.deleteMany({ where: { id: saved.id, userId } }),
  );
}

/** Free + no multi_account: may this user add a primary Google inbox (no linked row)? */
async function mayAddPrimaryGoogle(userId: string): Promise<boolean> {
  if (await hasMultiAccount(userId)) return true;
  const linked = await prisma.linkedInboxAccount.findFirst({
    where: { userId, ...NOT_KLORN_ADDRESS },
    select: { id: true },
  });
  return linked === null;
}

/**
 * The primary Google slot (POST /google/start and its integration callback) is
 * one per user. A user who already has a primary token is repairing it, which is
 * never gated; a NEW primary inbox on Free needs no linked row.
 */
export async function mayConnectPrimaryGoogle(userId: string): Promise<boolean> {
  if (!PAYWALL_ENABLED) return true;
  if (await hasPrimaryGoogleToken(userId)) return true;
  return mayAddPrimaryGoogle(userId);
}

/**
 * Check-after-write for a primary token this request just CREATED (call it
 * only when no token existed before the write). Fails closed like
 * keepIfOnlyMailSource and deletes exactly that token, by id.
 */
export async function keepPrimaryGoogleIfOnlyMailSource(
  userId: string,
  tokenId: string,
): Promise<boolean> {
  if (!PAYWALL_ENABLED) return true;
  return keepOrRollBack(
    "primary",
    userId,
    () => mayAddPrimaryGoogle(userId),
    () => prisma.userToken.deleteMany({ where: { id: tokenId, userId } }),
  );
}

/** For the settings UI: may this user connect a NEW mail account right now? */
export async function canConnectNewMailAccount(userId: string): Promise<boolean> {
  if (!PAYWALL_ENABLED) return true;
  if (await hasMultiAccount(userId)) return true;
  return !(await hasConnectedMailSource(userId));
}

/**
 * A primary Google inbox or a linked mailbox. Unlike "has any mail"
 * (mail/mail-source.ts), the Klorn address does not count: it is part of the
 * account, not a connected source (mail/klorn-mailbox.ts).
 */
async function hasConnectedMailSource(userId: string): Promise<boolean> {
  const [primary, linked] = await Promise.all([
    hasPrimaryGoogleToken(userId),
    prisma.linkedInboxAccount.findFirst({
      where: { userId, ...NOT_KLORN_ADDRESS },
      select: { id: true },
    }),
  ]);
  return primary || linked !== null;
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
