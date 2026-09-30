/**
 * Token lifecycle of an OUTLOOK LinkedCalendarAccount (step C4): decrypt, refresh
 * when the access token is about to lapse, persist Microsoft's ROTATED refresh
 * token, and report a dead grant in the shape the shared failure policy
 * (pim/linked-calendar-failure.ts) recognises.
 *
 * It mirrors mail/outlook-token.ts over the calendar table. That module is tied
 * to LinkedInboxAccount (its writes and its reconnect flag), so this is a sibling
 * rather than a parameterisation of it; unifying the two is a follow-up.
 *
 * The refresh is LAZY. `connect` only decrypts, and the refresh happens on the
 * first request, so a revoked grant rejects inside the caller's own try/catch and
 * takes the same path a 401 does (flag for reconnect, throttled warn, no Sentry).
 * A throw out of `connect` would escape the dispatcher's loop and skip every
 * other account.
 */

import type { LinkedCalendarAccount } from "@prisma/client";
import {
  decryptOptional,
  decryptToken,
  encryptOptional,
  encryptToken,
} from "../../crypto-tokens.js";
import { prisma } from "../../db.js";
import { markLinkedCalendarForReconnect } from "../../mail/gmail.js";
import { type OutlookTokens, refreshOutlookTokens } from "../../mail/outlook-oauth.js";
import { captureError } from "../../sentry.js";

/**
 * Refresh this long before the token lapses, so one sync (a few paged requests)
 * never starts with a token that expires in the middle of it.
 */
const EXPIRY_SLACK_MS = 5 * 60_000;

export interface OutlookCalendarTokenSource {
  /** A usable bearer token, refreshed at most once per source. Rejects when the account needs a re-link. */
  accessToken(): Promise<string>;
}

interface StoredTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
}

/** An OAuth error in the shape isRevokedGoogleGrantError matches (code and message prefix). */
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

/** The stored ciphers in the clear, or null (and flagged for reconnect) when they are unusable. */
function readStoredTokens(userId: string, row: LinkedCalendarAccount): StoredTokens | null {
  try {
    const accessToken = row.accessToken ? decryptToken(row.accessToken) : "";
    const refreshToken = decryptOptional(row.refreshToken);
    if (accessToken || refreshToken) return { accessToken, refreshToken };
    console.warn(
      `[OUTLOOK-CAL] Linked calendar ${row.id} has empty tokens — flagging for reconnect`,
    );
  } catch {
    console.warn(`[OUTLOOK-CAL] Skipping linked calendar ${row.id} — token decrypt failed`);
  }
  flagForReconnect(userId, row.id);
  return null;
}

function hasTimeLeft(expiresAt: Date | null): boolean {
  return expiresAt !== null && expiresAt.getTime() > Date.now() + EXPIRY_SLACK_MS;
}

/**
 * Save a refreshed token pair. Microsoft rotates the refresh token, so a rotation
 * is written unconditionally (the previous one is already dead at Microsoft); an
 * access-only refresh only replaces an older token, never a newer one a
 * concurrent tick stored. A failed save must not lose the tick: the new token is
 * valid in memory, so the failure is reported and the sync goes on.
 */
async function persistRefreshed(
  userId: string,
  linkedAccountId: string,
  refreshed: OutlookTokens,
): Promise<void> {
  const rotated = Boolean(refreshed.refreshToken);
  try {
    await prisma.linkedCalendarAccount.updateMany({
      where: {
        id: linkedAccountId,
        userId,
        ...(rotated || !refreshed.expiresAt
          ? {}
          : { OR: [{ expiresAt: null }, { expiresAt: { lt: refreshed.expiresAt } }] }),
      },
      data: {
        accessToken: encryptToken(refreshed.accessToken),
        ...(rotated ? { refreshToken: encryptOptional(refreshed.refreshToken) } : {}),
        expiresAt: refreshed.expiresAt,
        // A token that refreshed is healthy again; clear a stale reconnect prompt.
        needsReconnect: false,
      },
    });
  } catch (err) {
    console.warn(
      `[OUTLOOK-CAL] token persist failed for ${linkedAccountId} (syncing anyway):`,
      err,
    );
    captureError(err, {
      tags: { scope: "outlook-calendar.token-persist" },
      extra: { userId, linkedCalendarAccountId: linkedAccountId },
    });
  }
}

async function resolveAccessToken(
  userId: string,
  row: LinkedCalendarAccount,
  stored: StoredTokens,
): Promise<string> {
  if (stored.accessToken && hasTimeLeft(row.expiresAt)) return stored.accessToken;
  if (!stored.refreshToken) {
    // Expired with nothing to refresh it: only the user can fix it.
    throw oauthError("invalid_grant", "no refresh token is stored for this account");
  }
  // The CALENDAR scope set: a refresh asked for the inbox scopes would mint a
  // token without Calendars.Read.
  const refreshed = await refreshOutlookTokens(stored.refreshToken, "calendar");
  if ("error" in refreshed) throw oauthError(refreshed.error, "Microsoft token refresh failed");
  await persistRefreshed(userId, row.id, refreshed);
  return refreshed.accessToken;
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
  let pending: Promise<string> | null = null;
  return {
    // One resolution per source: every call of one session shares it, and a
    // revoked grant is not retried against Microsoft within the same sync.
    accessToken: () => {
      pending ??= resolveAccessToken(userId, row, stored);
      return pending;
    },
  };
}
