/**
 * What a refreshed Microsoft token pair is saved as, shared by the two Outlook
 * token lifecycles: mail/outlook-token.ts (LinkedInboxAccount) and
 * pim/calendar-providers/outlook-token.ts (LinkedCalendarAccount). Only the table
 * and the reconnect marker differ between them, so the write rule lives here once.
 *
 * Microsoft ROTATES refresh tokens, so a rotation is written unconditionally (the
 * previous refresh token is already dead at Microsoft either way). An access-only
 * refresh only replaces an older access token: the guard keeps a stale concurrent
 * tick from overwriting a newer one (mirror of gmail's decideRefreshTokenWrite).
 * A token that refreshed is healthy again, so the reconnect prompt is cleared.
 */

import { encryptOptional, encryptToken } from "../crypto-tokens.js";
import type { OutlookTokens } from "./outlook-oauth.js";

export interface RefreshedTokenUpdate {
  /** Conditions to add to the row's `{ id, userId }` match: `{}` or the stale-write guard. */
  readonly where: { OR?: Array<{ expiresAt: null } | { expiresAt: { lt: Date } }> };
  readonly data: {
    readonly accessToken: string;
    readonly refreshToken?: string | null;
    readonly expiresAt: Date | null;
    readonly needsReconnect: false;
  };
}

export function refreshedTokenUpdate(refreshed: OutlookTokens): RefreshedTokenUpdate {
  const rotated = Boolean(refreshed.refreshToken);
  return {
    where:
      rotated || !refreshed.expiresAt
        ? {}
        : { OR: [{ expiresAt: null }, { expiresAt: { lt: refreshed.expiresAt } }] },
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
