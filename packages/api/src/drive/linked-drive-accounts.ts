/**
 * The one module that touches LinkedDriveAccount (step D5b of
 * docs/providers/unified-platform-plan.md). A row is a Google Drive (D5) or
 * OneDrive (D6) account linked for its files: an OAuth token pair, encrypted
 * under the TOKEN_ENCRYPTION_KEYS ring, and the address it belongs to.
 * drive-file-guard.test.ts fails for a query of the table anywhere else (the
 * user purge and the key-rotation sweep excepted), and for an `include` or a
 * relation `select` that would carry the tokens out with another row.
 *
 * Rules every function here keeps:
 *   - every query names the user, and a single-account query also names the
 *     account id and, where it reads or deletes, the provider: the DriveFile
 *     foreign key proves an account exists, not who owns it;
 *   - a token is written only through `encryptToken`, and never empty:
 *     encryptToken("") answers "", which the NOT NULL columns would keep as if
 *     it were a token;
 *   - the address is stored trimmed and lower-cased (the table's CHECK);
 *   - nothing returned for display carries a token or the granted scopes.
 */

import { encryptToken } from "../crypto-tokens.js";
import { INTERACTIVE_TX_OPTIONS, prisma } from "../db.js";
import { type ConnectedDriveProvider, deleteConnectedDriveRows } from "./drive-rows.js";

/** How many accounts of one provider one user may link (plan, D5 "Grant"). */
export const MAX_DRIVE_ACCOUNTS_PER_PROVIDER = 5;
/** RFC 5321's longest path; anything longer is not an address. */
const MAX_EMAIL_CHARS = 320;

/** What a link stores: the plain token pair (encrypted here) and what Google granted. */
export interface DriveAccountGrant {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: Date | null;
  /** The token response's space-delimited `scope`. */
  readonly grantedScopes: string;
}

/** An account as the user sees it: never a token, never the scopes. */
export interface DriveAccountSummary {
  readonly id: string;
  readonly email: string;
  readonly needsReconnect: boolean;
  readonly createdAt: Date;
}

/** An account's ciphers, for the one place that builds its client. Never sent anywhere. */
export interface DriveAccountCredentials {
  readonly id: string;
  readonly email: string;
  /** encryptToken ciphers, as stored. */
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: Date | null;
  readonly needsReconnect: boolean;
}

/** A refresh's result, plain; empty tokens are not written. */
export interface RefreshedDriveTokens {
  readonly accessToken: string;
  /** Present only when the provider rotated the refresh token. */
  readonly refreshToken?: string;
  readonly expiresAt: Date | null;
  /** Write only when the stored expiry is unknown or earlier: a stale refresh must not win. */
  readonly onlyIfNewer: boolean;
}

export type DriveAccountSaveResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reason: "empty-token" | "email" };

const DRIVE_ACCOUNT_SUMMARY_SELECT = {
  id: true,
  email: true,
  needsReconnect: true,
  createdAt: true,
} as const;
const DRIVE_ACCOUNT_CREDENTIALS_SELECT = {
  id: true,
  email: true,
  accessToken: true,
  refreshToken: true,
  expiresAt: true,
  needsReconnect: true,
} as const;

/** The address as the table's CHECK requires it: email = lower(btrim(email)). */
export function normaliseDriveAccountEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isStorableEmail(email: string): boolean {
  return (
    email.length > 0 && email.length <= MAX_EMAIL_CHARS && email.includes("@") && !/\s/.test(email)
  );
}

/**
 * Create the account, or bring a re-linked one up to date in place (its
 * reconnect flag cleared). The address is normalised here whatever the caller
 * did. Refuses, writing nothing, an empty token or an address that is not one.
 */
export async function saveLinkedDriveAccount(
  userId: string,
  provider: ConnectedDriveProvider,
  rawEmail: string,
  grant: DriveAccountGrant,
): Promise<DriveAccountSaveResult> {
  if (!grant.accessToken || !grant.refreshToken) {
    return { ok: false, reason: "empty-token" };
  }
  const email = normaliseDriveAccountEmail(rawEmail);
  if (!isStorableEmail(email)) return { ok: false, reason: "email" };
  const tokens = {
    accessToken: encryptToken(grant.accessToken),
    refreshToken: encryptToken(grant.refreshToken),
    expiresAt: grant.expiresAt,
    grantedScopes: grant.grantedScopes,
  };
  const saved = await prisma.linkedDriveAccount.upsert({
    where: { userId_provider_email: { userId, provider, email } },
    update: { ...tokens, needsReconnect: false },
    create: { userId, provider, email, ...tokens },
    select: { id: true },
  });
  return { ok: true, id: saved.id };
}

/** True when this user already linked this address for this provider (a re-link). */
export async function isDriveAccountLinked(
  userId: string,
  provider: ConnectedDriveProvider,
  rawEmail: string,
): Promise<boolean> {
  const email = normaliseDriveAccountEmail(rawEmail);
  const found = await prisma.linkedDriveAccount.findFirst({
    where: { userId, provider, email },
    select: { id: true },
  });
  return found !== null;
}

/** How many accounts of this provider the user has linked. */
export async function countDriveAccounts(
  userId: string,
  provider: ConnectedDriveProvider,
): Promise<number> {
  return prisma.linkedDriveAccount.count({ where: { userId, provider } });
}

/** The user's accounts of this provider, oldest first, as the user may see them. */
export async function listDriveAccounts(
  userId: string,
  provider: ConnectedDriveProvider,
): Promise<DriveAccountSummary[]> {
  return prisma.linkedDriveAccount.findMany({
    where: { userId, provider },
    select: DRIVE_ACCOUNT_SUMMARY_SELECT,
    orderBy: { createdAt: "asc" },
  });
}

/** One account's ciphers, only when it is this user's and this provider's; else null. */
export async function loadDriveAccountCredentials(
  userId: string,
  provider: ConnectedDriveProvider,
  accountId: string,
): Promise<DriveAccountCredentials | null> {
  return prisma.linkedDriveAccount.findFirst({
    where: { id: accountId, userId, provider },
    select: DRIVE_ACCOUNT_CREDENTIALS_SELECT,
  });
}

/** Only a re-link can fix this account (a dead or undecryptable grant): say so. */
export async function markDriveAccountForReconnect(
  userId: string,
  accountId: string,
): Promise<void> {
  await prisma.linkedDriveAccount.updateMany({
    where: { id: accountId, userId },
    data: { needsReconnect: true },
  });
}

/**
 * Save a refresh of this user's account: the tokens it brought (an empty one is
 * left as stored), healthy again, stamped. False when nothing was written: no
 * token to write, not this user's account, or (onlyIfNewer) a later token is
 * already stored.
 */
export async function saveRefreshedDriveTokens(
  userId: string,
  accountId: string,
  tokens: RefreshedDriveTokens,
): Promise<boolean> {
  if (!tokens.accessToken && !tokens.refreshToken) return false;
  const newer =
    tokens.onlyIfNewer && tokens.expiresAt
      ? { OR: [{ expiresAt: null }, { expiresAt: { lt: tokens.expiresAt } }] }
      : {};
  const written = await prisma.linkedDriveAccount.updateMany({
    where: { id: accountId, userId, ...newer },
    data: {
      ...(tokens.accessToken && { accessToken: encryptToken(tokens.accessToken) }),
      ...(tokens.refreshToken && { refreshToken: encryptToken(tokens.refreshToken) }),
      expiresAt: tokens.expiresAt,
      needsReconnect: false,
      lastRefreshedAt: new Date(),
    },
  });
  return written.count > 0;
}

/**
 * Unlink one account of this user: its DriveFile rows (through the writer, by
 * sourceKey) and then the account, in one transaction. False, having deleted
 * nothing, when the account is not this user's or not this provider's. The
 * foreign key's cascade also covers a row a refresh still in flight writes
 * meanwhile: it fails instead of outliving the account.
 */
export async function unlinkDriveAccount(
  userId: string,
  provider: ConnectedDriveProvider,
  accountId: string,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const account = await tx.linkedDriveAccount.findFirst({
      where: { id: accountId, userId, provider },
      select: { id: true },
    });
    if (!account) return false;
    await deleteConnectedDriveRows(tx, userId, provider, account.id);
    // The count decides, not the lookup: a concurrent unlink that got here
    // second deleted nothing and answers "not found".
    const removed = await tx.linkedDriveAccount.deleteMany({
      where: { id: accountId, userId, provider },
    });
    return removed.count > 0;
  }, INTERACTIVE_TX_OPTIONS);
}
