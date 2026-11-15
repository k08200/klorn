/**
 * Organization invite tokens (Klorn Teams v1). The same standard as the
 * password-reset and email-verification tokens (one-time-token.ts): 256 random
 * bits, only the SHA-256 is stored in OrgInvite.tokenHash, and the raw token
 * exists in the invite mail alone. Redemption hashes what it is given and
 * looks the hash up, so a database read never yields a usable invite.
 */

import { hashOneTimeToken, mintOneTimeToken } from "../one-time-token.js";

/** An invite is good for seven days. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const TOKEN_SHAPE = /^[0-9a-f]{64}$/;

export function mintInviteToken(): { token: string; tokenHash: string } {
  return mintOneTimeToken();
}

export function hashInviteToken(token: string): string {
  return hashOneTimeToken(token);
}

/** True only for the minted shape, so garbage is refused before any lookup. */
export function isWellFormedInviteToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_SHAPE.test(value);
}

export function inviteExpiry(now: Date): Date {
  return new Date(now.getTime() + INVITE_TTL_MS);
}
