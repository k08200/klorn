/**
 * What a refreshed Microsoft token pair is saved as, shared by the two Outlook
 * token lifecycles: mail/outlook-token.ts (LinkedInboxAccount) and
 * pim/calendar-providers/outlook-token.ts (LinkedCalendarAccount). Only the table
 * and the reconnect marker differ between them, so the write rule lives here once.
 *
 * Microsoft ROTATES refresh tokens. Two refreshes of one account at once (a poll
 * tick and an action, a sync and a conflict check) both redeem the same old refresh
 * token, so a rotation is a compare-and-swap on it: `previousRefreshCipher`, the
 * cipher the caller read, becomes a condition of the write. The loser's write then
 * matches no row (count 0) instead of overwriting the winner's newer token with
 * one that Microsoft has already superseded, and the caller can re-read. An
 * access-only refresh only replaces an older access token: the expiry guard keeps a
 * stale concurrent tick from overwriting a newer one (mirror of gmail's
 * decideRefreshTokenWrite). A token that refreshed is healthy again, so the
 * reconnect prompt is cleared.
 */

import { encryptOptional, encryptToken } from "../crypto-tokens.js";
import type { OutlookTokens } from "./outlook-oauth.js";

export interface RefreshedTokenUpdate {
  /**
   * Conditions to add to the row's `{ id, userId }` match: the swap on the refresh
   * cipher (a rotation), the stale-write guard (an access-only refresh), or `{}`.
   */
  readonly where: {
    refreshToken?: string | null;
    OR?: Array<{ expiresAt: null } | { expiresAt: { lt: Date } }>;
  };
  readonly data: {
    readonly accessToken: string;
    readonly refreshToken?: string | null;
    readonly expiresAt: Date | null;
    readonly needsReconnect: false;
  };
}

/**
 * @param previousRefreshCipher the refresh cipher the row held when it was read, for
 *   the swap on a rotation: `undefined` asks for no condition, `null` means the row
 *   held none.
 */
export function refreshedTokenUpdate(
  refreshed: OutlookTokens,
  previousRefreshCipher?: string | null,
): RefreshedTokenUpdate {
  const rotated = Boolean(refreshed.refreshToken);
  return {
    where: rotated
      ? previousRefreshCipher === undefined
        ? {}
        : { refreshToken: previousRefreshCipher }
      : refreshed.expiresAt
        ? { OR: [{ expiresAt: null }, { expiresAt: { lt: refreshed.expiresAt } }] }
        : {},
    data: {
      accessToken: encryptToken(refreshed.accessToken),
      // Rotation: persist the NEW refresh token when Microsoft sent one; keep the
      // old cipher otherwise (some responses omit it).
      ...(rotated ? { refreshToken: encryptOptional(refreshed.refreshToken) } : {}),
      expiresAt: refreshed.expiresAt,
      needsReconnect: false,
    },
  };
}
