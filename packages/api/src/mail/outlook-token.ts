/**
 * OUTLOOK token lifecycle — decrypt, proactive refresh (Microsoft ROTATES
 * refresh tokens; the new cipher must be persisted), and reconnect flagging.
 * Split from outlook-accounts.ts so the ACTION surface
 * (mail/providers/outlook.ts) can share it without dragging the whole
 * ingestion chain (outlook-sync -> shared persist path) into its import graph.
 */

import { decryptOptional, decryptToken } from "../crypto-tokens.js";
import { prisma } from "../db.js";
import { captureError } from "../sentry.js";
import { markLinkedInboxForReconnect } from "./gmail.js";
import { refreshOutlookTokens } from "./outlook-oauth.js";
import { refreshedTokenUpdate } from "./outlook-token-update.js";

// Refresh BEFORE the token can expire between ticks: the poll runs every
// 5 minutes, so anything with less than one interval (+ margin) left would
// come back 401 on the NEXT tick and false-flag a healthy account for
// reconnect. Slack must therefore exceed the poll interval.
const EXPIRY_SLACK_MS = 7 * 60_000; // poll interval (5m) + 2m margin

export interface OutlookRow {
  id: string;
  email: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date | null;
  historyId: string | null;
}

/**
 * Resolve a usable bearer token for one row, refreshing (and persisting the
 * rotated ciphers) when needed. Returns null when the row cannot sync — the
 * caller skips it; reconnect marking already happened here.
 */
export async function resolveAccessToken(userId: string, row: OutlookRow): Promise<string | null> {
  if (!row.accessToken) return null;

  let accessToken: string;
  try {
    accessToken = decryptToken(row.accessToken);
  } catch (err) {
    // Undecryptable cipher (key rotation gap, hand-edited row): durable flag,
    // fire-and-forget — same contract as the Google linked path.
    console.warn(`[outlook-accounts] undecryptable token for row ${row.id}:`, err);
    void markLinkedInboxForReconnect(userId, row.id, "OUTLOOK").catch((markErr) => {
      console.warn(`[outlook-accounts] reconnect mark failed for row ${row.id}:`, markErr);
    });
    return null;
  }
  let refreshToken: string | null = null;
  try {
    refreshToken = decryptOptional(row.refreshToken);
  } catch (err) {
    // A rotten refresh cipher alone must not discard a still-valid access
    // token: sync with it now; the refresh-needed branch below flags
    // reconnect once the access token actually runs out.
    console.warn(`[outlook-accounts] undecryptable refresh cipher for row ${row.id}:`, err);
  }

  const fresh = row.expiresAt && row.expiresAt.getTime() > Date.now() + EXPIRY_SLACK_MS;
  if (fresh) return accessToken;

  if (!refreshToken) {
    // Expired with no refresh token — nothing to do but ask the user.
    void markLinkedInboxForReconnect(userId, row.id, "OUTLOOK").catch((markErr) => {
      console.warn(`[outlook-accounts] reconnect mark failed for row ${row.id}:`, markErr);
    });
    return null;
  }

  const refreshed = await refreshOutlookTokens(refreshToken);
  if ("error" in refreshed) {
    // invalid_grant = revoked/aged-out; any other code is equally terminal
    // for this tick — flag and let the user re-link.
    void markLinkedInboxForReconnect(userId, row.id, "OUTLOOK").catch((markErr) => {
      console.warn(`[outlook-accounts] reconnect mark failed for row ${row.id}:`, markErr);
    });
    return null;
  }
  try {
    const update = refreshedTokenUpdate(refreshed);
    await prisma.linkedInboxAccount.updateMany({
      where: { id: row.id, userId, ...update.where },
      data: update.data,
    });
  } catch (err) {
    // A transient DB failure must not lose the tick — the fresh tokens are
    // in memory and valid. Worst case the rotated refresh cipher is lost and
    // the NEXT refresh invalid_grants into a reconnect prompt; log loudly so
    // that shows up as this write failing, not as a mystery reconnect.
    console.warn(
      `[outlook-accounts] token persist failed for row ${row.id} (syncing anyway):`,
      err,
    );
    captureError(err, {
      tags: { scope: "outlook-accounts.token-persist" },
      extra: { userId, linkedInboxAccountId: row.id },
    });
  }
  return refreshed.accessToken;
}

/**
 * Resolve a usable bearer + mailbox address for ONE linked OUTLOOK account —
 * the action surface (mail/providers/outlook.ts) shares the poll path's
 * refresh/rotation/reconnect lifecycle instead of duplicating it. Null when
 * the row is missing or cannot auth (reconnect marking already handled in
 * resolveAccessToken).
 */
export async function resolveOutlookBearer(
  userId: string,
  linkedInboxAccountId: string,
): Promise<{ accessToken: string; email: string } | null> {
  const row = await prisma.linkedInboxAccount.findFirst({
    where: { id: linkedInboxAccountId, userId, provider: "OUTLOOK" },
  });
  if (!row?.email) return null;
  const accessToken = await resolveAccessToken(userId, row);
  if (!accessToken) return null;
  return { accessToken, email: row.email };
}
