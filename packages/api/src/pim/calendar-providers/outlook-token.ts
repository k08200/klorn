/**
 * Token lifecycle of an OUTLOOK LinkedCalendarAccount (step C4 of
 * docs/providers/unified-platform-plan.md): decrypt, refresh when the access token
 * is about to lapse, persist Microsoft's ROTATED refresh token, and report a dead
 * grant in the shape the shared failure policy (pim/linked-calendar-failure.ts)
 * recognises.
 *
 * It mirrors mail/outlook-token.ts over the calendar table. That module is tied
 * to LinkedInboxAccount (its reconnect flag), so this is a sibling; the one rule
 * that is identical, what a refreshed token pair is saved as, is shared
 * (mail/outlook-token-update.ts).
 *
 * Two refreshes of one account can run at once (a sync tick and a conflict check).
 * Microsoft rotates the refresh token, so a rotation is saved as a compare-and-swap
 * on the refresh cipher that was read; the loser re-reads the row and uses the
 * winner's token, and an invalid_grant is checked against the row before it is
 * allowed to flag the account (the winner may simply have got there first).
 *
 * The refresh is LAZY. `connect` only decrypts, and the refresh happens on the
 * first request, so a revoked grant rejects inside the caller's own try/catch and
 * takes the same path a 401 does (flag for reconnect, throttled warn, no Sentry).
 * A throw out of `connect` would escape the dispatcher's loop and skip every
 * other account.
 */

import type { LinkedCalendarAccount } from "@prisma/client";
import { decryptOptional, decryptToken } from "../../crypto-tokens.js";
import { prisma } from "../../db.js";
import { markLinkedCalendarForReconnect } from "../../mail/gmail.js";
import { type OutlookTokens, refreshOutlookTokens } from "../../mail/outlook-oauth.js";
import { refreshedTokenUpdate } from "../../mail/outlook-token-update.js";
import { captureError } from "../../sentry.js";

/**
 * Refresh this long before the token lapses, so one sync (a few paged requests)
 * never starts with a token that expires in the middle of it.
 */
const EXPIRY_SLACK_MS = 5 * 60_000;
/** How much of a database error's first line is logged; the rest can carry row values. */
const MAX_LOGGED_ERROR_LENGTH = 200;

export interface OutlookCalendarTokenSource {
  /** A usable bearer token, refreshed at most once per source. Rejects when the account needs a re-link. */
  accessToken(): Promise<string>;
  /**
   * Graph answered 401 to `failedToken`. A token that still looked fresh can be
   * dead (revoked, or issued before a password change), so the account is given
   * ONE forced refresh before it is declared revoked: answers the token to retry
   * with, or null when a refresh cannot help (the token in use already came from
   * one, so the 401 is real). Rejects in the revoked-grant shape when the refresh
   * is refused or there is nothing to refresh with.
   */
  renewAfterUnauthorized(failedToken: string): Promise<string | null>;
}

interface StoredTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
}

/** An OAuth error in the shape isRevokedGrantError matches (code and message prefix). */
function oauthError(code: string, detail: string): Error {
  return Object.assign(new Error(`${code}: ${detail}`), { code });
}

function flagForReconnect(userId: string, linkedAccountId: string): void {
  void markLinkedCalendarForReconnect(userId, linkedAccountId).catch((markErr) => {
    console.error(
      `[OUTLOOK-CAL] Failed to flag linked calendar ${linkedAccountId} for reconnect:`,
      markErr,
    );
    captureError(markErr, { tags: { scope: "outlook-calendar.mark-reconnect" } });
  });
}

/**
 * The stored ciphers in the clear, or null (and flagged for reconnect) when they
 * are unusable. Like the mail path, a rotten REFRESH cipher alone does not discard
 * a still-valid access token: the sync goes on with it, and the refresh that is
 * then needed surfaces as a revoked grant once the access token runs out.
 */
function readStoredTokens(userId: string, row: LinkedCalendarAccount): StoredTokens | null {
  let accessToken = "";
  try {
    accessToken = row.accessToken ? decryptToken(row.accessToken) : "";
  } catch {
    console.warn(`[OUTLOOK-CAL] Skipping linked calendar ${row.id} — token decrypt failed`);
    flagForReconnect(userId, row.id);
    return null;
  }
  let refreshToken: string | null = null;
  try {
    refreshToken = decryptOptional(row.refreshToken);
  } catch {
    console.warn(`[OUTLOOK-CAL] Linked calendar ${row.id} has an undecryptable refresh token`);
  }
  if (accessToken || refreshToken) return { accessToken, refreshToken };
  console.warn(
    `[OUTLOOK-CAL] Linked calendar ${row.id} has no usable tokens — flagging for reconnect`,
  );
  flagForReconnect(userId, row.id);
  return null;
}

function hasTimeLeft(expiresAt: Date | null): boolean {
  return expiresAt !== null && expiresAt.getTime() > Date.now() + EXPIRY_SLACK_MS;
}

/** A database error as one safe line: class, code and the first line of its message, capped. */
function describeDbError(err: unknown): string {
  if (!(err instanceof Error)) return typeof err;
  const code = (err as { code?: unknown }).code;
  const firstLine = err.message.split("\n").find((line) => line.trim() !== "") ?? "";
  return `${err.name}${typeof code === "string" ? ` ${code}` : ""}: ${firstLine.slice(0, MAX_LOGGED_ERROR_LENGTH)}`;
}

/**
 * Save a refreshed token pair (the write rule is shared with the mail path, see
 * mail/outlook-token-update.ts). `previousCipher` is the refresh cipher the new
 * pair replaces: a rotation matches only a row that still holds it. Answers
 * whether the write landed: false means another refresh stored first, or that the
 * save failed (reported, and the sync goes on: the new token is valid in memory).
 * The log and Sentry get a sanitised summary, never the raw database error, whose
 * message can carry the row values being written.
 */
async function persistRefreshed(
  userId: string,
  linkedAccountId: string,
  previousCipher: string | null,
  refreshed: OutlookTokens,
): Promise<boolean> {
  try {
    const update = refreshedTokenUpdate(refreshed, previousCipher);
    const written = await prisma.linkedCalendarAccount.updateMany({
      where: { id: linkedAccountId, userId, ...update.where },
      data: update.data,
    });
    return written.count > 0;
  } catch (err) {
    const summary = describeDbError(err);
    console.warn(
      `[OUTLOOK-CAL] token persist failed for ${linkedAccountId} (syncing anyway): ${summary}`,
    );
    captureError(new Error(summary), {
      tags: { scope: "outlook-calendar.token-persist" },
      extra: { userId, linkedCalendarAccountId: linkedAccountId },
    });
    return false;
  }
}

interface LatestTokens {
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
  readonly refreshCipher: string | null;
  readonly expiresAt: Date | null;
}

/** The row as it is now (another refresh may have changed it), or null when it cannot be read. */
async function readLatestTokens(
  userId: string,
  linkedAccountId: string,
): Promise<LatestTokens | null> {
  try {
    const row = await prisma.linkedCalendarAccount.findFirst({
      where: { id: linkedAccountId, userId, provider: "OUTLOOK" },
      select: { accessToken: true, refreshToken: true, expiresAt: true },
    });
    if (!row) return null;
    return {
      accessToken: row.accessToken ? decryptToken(row.accessToken) : null,
      refreshToken: decryptOptional(row.refreshToken),
      refreshCipher: row.refreshToken,
      expiresAt: row.expiresAt,
    };
  } catch (err) {
    console.warn(`[OUTLOOK-CAL] re-reading ${linkedAccountId} failed: ${describeDbError(err)}`);
    return null;
  }
}

/** Save a refreshed pair; when another refresh stored first, use ITS access token if it still has time. */
async function saveRefreshed(
  userId: string,
  row: LinkedCalendarAccount,
  previousCipher: string | null,
  refreshed: OutlookTokens,
): Promise<string> {
  const stored = await persistRefreshed(userId, row.id, previousCipher, refreshed);
  if (stored || !refreshed.refreshToken) return refreshed.accessToken;
  // The swap matched nothing: another refresh stored first. Its token is the one on
  // the row, so use it when it is usable; this refresh's own is valid too, and is
  // the fallback.
  const latest = await readLatestTokens(userId, row.id);
  return latest?.accessToken && hasTimeLeft(latest.expiresAt)
    ? latest.accessToken
    : refreshed.accessToken;
}

/** One refresh with the stored refresh token, saved; rejects in the revoked-grant shape on a refusal. */
async function refreshAccessToken(
  userId: string,
  row: LinkedCalendarAccount,
  stored: StoredTokens,
): Promise<string> {
  if (!stored.refreshToken) {
    // Nothing to refresh with: only the user can fix it.
    throw oauthError("invalid_grant", "no refresh token is stored for this account");
  }
  // The CALENDAR scope set: a refresh asked for the inbox scopes would mint a
  // token without Calendars.Read.
  const refreshed = await refreshOutlookTokens(stored.refreshToken, "calendar");
  if (!("error" in refreshed)) return saveRefreshed(userId, row, row.refreshToken, refreshed);
  if (refreshed.error !== "invalid_grant") {
    throw oauthError(refreshed.error, "Microsoft token refresh failed");
  }
  return retryAfterInvalidGrant(userId, row);
}

/**
 * Microsoft refused the refresh token as invalid_grant. That is what a revoked grant
 * answers, and also what the LOSER of two concurrent refreshes gets when the winner's
 * rotation has already superseded the token it redeemed. So the row is read again
 * before anything flags the account: if its refresh cipher changed since this one
 * was read, the winner's token is used (its access token as it is when still fresh,
 * else one retry with its refresh token); only an unchanged cipher, or a refusal of
 * the new one too, is a revoked grant.
 */
async function retryAfterInvalidGrant(userId: string, row: LinkedCalendarAccount): Promise<string> {
  const revoked = () => oauthError("invalid_grant", "Microsoft token refresh failed");
  const latest = await readLatestTokens(userId, row.id);
  if (!latest?.refreshToken || latest.refreshCipher === row.refreshToken) throw revoked();
  if (latest.accessToken && hasTimeLeft(latest.expiresAt)) return latest.accessToken;
  const retried = await refreshOutlookTokens(latest.refreshToken, "calendar");
  if ("error" in retried) throw oauthError(retried.error, "Microsoft token refresh failed");
  return saveRefreshed(userId, row, latest.refreshCipher, retried);
}

/**
 * A token source for one linked OUTLOOK calendar account, or null (the account is
 * flagged for reconnect) when its stored tokens are unusable.
 */
export function createOutlookCalendarTokenSource(
  userId: string,
  row: LinkedCalendarAccount,
): OutlookCalendarTokenSource | null {
  const stored = readStoredTokens(userId, row);
  if (!stored) return null;
  // True once the token in use came from a refresh (the initial one, or a forced
  // one): a 401 on it is then real, and a further refresh cannot help.
  let refreshed = false;
  let current: Promise<string> | null = null;

  const initial = (): Promise<string> => {
    if (stored.accessToken && hasTimeLeft(row.expiresAt)) {
      return Promise.resolve(stored.accessToken);
    }
    refreshed = true;
    return refreshAccessToken(userId, row, stored);
  };

  return {
    // One resolution per source: every call of one session shares it, and a
    // revoked grant is not retried against Microsoft within the same sync.
    accessToken: () => {
      current ??= initial();
      return current;
    },
    async renewAfterUnauthorized(failedToken) {
      current ??= initial();
      const inUse = await current;
      // Already renewed since `failedToken` was used: retry with what is in use now.
      if (inUse !== failedToken) return inUse;
      if (refreshed) return null;
      refreshed = true;
      current = refreshAccessToken(userId, row, stored);
      return current;
    },
  };
}
