/**
 * The Google Drive grant (step D5b of docs/providers/unified-platform-plan.md):
 * the consent URL of a link, the link's completion, and the OAuth client of a
 * linked account.
 *
 * Separate and incremental (plan, D5 "Grant"). A link asks for exactly
 * `openid`, `userinfo.email` and `drive.file`, offline and with consent, under
 * the same client and redirect URI as sign-in, Gmail, Calendar and the inbox
 * links (so the redirect needs no console change). It never asks for
 * `include_granted_scopes`: with it, picking the primary's Google account would
 * hand back a token that also carries the Gmail and Calendar scopes. The state
 * is server-signed for 10 minutes with the `__link_drive__` marker, and only the
 * dark POST /api/drive/google/link signs one.
 *
 * Bound to the session that started it (#1451): the Google callback does not
 * exchange the code, it parks it (routes/link-handoff.ts; only while the drive
 * is on), and POST /api/auth/link/complete calls `completeGoogleDriveLink` only
 * when the caller's session is the user who started the flow.
 *
 * The account rows are written and read through drive/linked-drive-accounts.ts
 * only. Nothing here calls Google beyond completing a link (the token exchange
 * and the userinfo read) and, from D5c, what the connector's session needs.
 */

import type { GoogleDriveLinkOutcome } from "@klorn/contract";
import type { google } from "googleapis";
import type { LinkMarker } from "../../auth/pending-links.js";
import { signToken } from "../../auth.js";
import { isEntitled } from "../../billing/stripe.js";
import { decryptToken } from "../../crypto-tokens.js";
import { prisma } from "../../db.js";
import { decideRefreshTokenWrite, getGoogleUserInfo, getOAuth2Client } from "../../mail/gmail.js";
import { isRevokedGrantError } from "../../pim/linked-calendar-failure.js";
import { captureError } from "../../sentry.js";
import { googleDriveRoutesEnabled } from "../drive-scope.js";
import {
  countDriveAccounts,
  type DriveAccountCredentials,
  isDriveAccountLinked,
  MAX_DRIVE_ACCOUNTS_PER_PROVIDER,
  markDriveAccountForReconnect,
  normaliseDriveAccountEmail,
  saveLinkedDriveAccount,
  saveRefreshedDriveTokens,
} from "../linked-drive-accounts.js";

/** The signed state's marker: picks the drive branch of the Google callback. */
export const DRIVE_LINK_STATE_MARKER = "__link_drive__" satisfies LinkMarker;
/** Picked files only: the one Drive scope Klorn asks for (P5). */
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
/** Exactly what a drive link asks for, in this order. */
export const DRIVE_LINK_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  DRIVE_FILE_SCOPE,
] as const;
/**
 * The scopes a drive grant may carry: what the link asks for, and `email`, the
 * short alias Google may report for `userinfo.email`. Anything else (a Gmail or
 * Calendar scope) means the consent was combined with another grant.
 */
const EXPECTED_GRANT_SCOPES: ReadonlySet<string> = new Set([...DRIVE_LINK_SCOPES, "email"]);
/** As the calendar and inbox links: an intercepted state URL must not be replayable for long. */
const STATE_TTL = "10m";
const FILES_PATH = "/files";

export type DriveLinkOutcome = GoogleDriveLinkOutcome;

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

/** A linked account's OAuth client, tagged with the account. */
export interface LinkedDriveClient {
  readonly client: OAuth2Client;
  readonly id: string;
  readonly email: string;
}

/** The Google tokens payload, as the token exchange and a refresh hand it over. */
interface GoogleTokens {
  readonly access_token?: string | null;
  readonly refresh_token?: string | null;
  readonly expiry_date?: number | null;
  readonly scope?: string | null;
}

/**
 * The consent URL of a drive link for this user, with its signed 10-minute
 * state. `appScheme` is an allowlisted native scheme (routes/link-handoff.ts
 * `linkStartScheme`), so the parked handle goes back to the app that started.
 */
export function getLinkDriveAuthUrl(
  userId: string,
  extra: { readonly appScheme?: string } = {},
): string {
  const state = signToken({ userId, email: DRIVE_LINK_STATE_MARKER, ...extra }, STATE_TTL);
  return getOAuth2Client().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    state,
    scope: [...DRIVE_LINK_SCOPES],
  });
}

/** Where the client lands after a link: a relative path, as every link completion answers. */
export function driveLinkPath(outcome: DriveLinkOutcome): string {
  return `${FILES_PATH}?drive=${outcome}`;
}

/**
 * True when the granted scopes include drive.file itself. Granular consent lets
 * the user untick it, and the grant then holds the identity scopes only.
 */
export function hasDriveFileScope(scope: string | null | undefined): boolean {
  return typeof scope === "string" && scope.split(/\s+/).includes(DRIVE_FILE_SCOPE);
}

/** The granted scopes beyond the expected set, as Google reported them; [] when none. */
export function unexpectedGrantScopes(scope: string | null | undefined): string[] {
  if (typeof scope !== "string") return [];
  return scope.split(/\s+/).filter((name) => name.length > 0 && !EXPECTED_GRANT_SCOPES.has(name));
}

/**
 * A grant that carries more than the link asked for is not refused (drive.file
 * is what the connector needs), but it is not expected either: say so, scope
 * names only, never a token.
 */
function reportUnexpectedScopes(userId: string, unexpected: readonly string[]): void {
  if (unexpected.length === 0) return;
  console.warn(`[GOOGLE-DRIVE] link granted scopes beyond the request: ${unexpected.join(" ")}`);
  captureError(new Error("Google Drive link granted scopes beyond the request"), {
    tags: { scope: "drive.google.extra_scopes" },
    extra: { userId, unexpectedScopes: [...unexpected] },
  });
}

/** requireEntitled's rule, again at callback time: the plan may lapse during the OAuth window. */
async function isLinkerEntitled(userId: string): Promise<boolean> {
  const linker = await prisma.user.findUnique({
    where: { id: userId },
    select: { plan: true, role: true },
  });
  return linker !== null && isEntitled(linker.plan, linker.role);
}

/** The cap applies to NEW accounts only: a re-link must always be allowed. */
async function isOverCap(userId: string, email: string): Promise<boolean> {
  if (await isDriveAccountLinked(userId, "GOOGLE", email)) return false;
  return (await countDriveAccounts(userId, "GOOGLE")) >= MAX_DRIVE_ACCOUNTS_PER_PROVIDER;
}

async function linkDriveAccount(code: string, userId: string): Promise<DriveLinkOutcome> {
  const { tokens } = await getOAuth2Client().getToken(code);
  if (!tokens.access_token) return "failed";
  reportUnexpectedScopes(userId, unexpectedGrantScopes(tokens.scope));
  if (!hasDriveFileScope(tokens.scope)) return "scope-missing";
  // A drive is refreshed in the background (D5d): without offline access it
  // would die within the hour.
  if (!tokens.refresh_token) return "failed";
  // A DIFFERENT Google account may be attached to the already signed-in user
  // (statePayload.userId). The session user is never resolved or switched by
  // this address; it only labels the account.
  const profile = await getGoogleUserInfo(tokens.access_token);
  if (profile.verified_email !== true) return "unverified";
  if (!(await isLinkerEntitled(userId))) return "failed";
  const email = normaliseDriveAccountEmail(profile.email ?? "");
  if (await isOverCap(userId, email)) return "limit";
  const saved = await saveLinkedDriveAccount(userId, "GOOGLE", email, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    grantedScopes: (tokens.scope ?? "").trim(),
  });
  return saved.ok ? "success" : "failed";
}

/**
 * The drive flow of POST /api/auth/link/complete: the code was parked by the
 * Google callback, and the caller's session is the user who started the link.
 * The code is exchanged here and nowhere else. The flag is read again first: a
 * link parked before the flag went off exchanges no code and stores nothing.
 * Never throws; a failure is logged and answers `failed`, with no provider
 * message on the wire.
 */
export async function completeGoogleDriveLink(params: {
  readonly code: string;
  readonly userId: string;
}): Promise<DriveLinkOutcome> {
  if (!googleDriveRoutesEnabled()) return "failed";
  try {
    return await linkDriveAccount(params.code, params.userId);
  } catch (err) {
    // console first: captureError is a no-op without a Sentry DSN.
    console.error(
      "[GOOGLE-DRIVE] link callback failed:",
      err instanceof Error ? err.message : String(err),
    );
    captureError(err, { tags: { scope: "drive.google.link-callback" } });
    return "failed";
  }
}

function flagForReconnect(userId: string, accountId: string): void {
  void markDriveAccountForReconnect(userId, accountId).catch((markErr) => {
    console.error(
      `[GOOGLE-DRIVE] Failed to flag drive account ${accountId} for reconnect:`,
      markErr,
    );
    captureError(markErr, { tags: { scope: "drive.google.mark-reconnect" } });
  });
}

/** Save what a refresh brought, scoped to (id, userId): `decideRefreshTokenWrite`'s rules. */
async function persistRefreshedDriveTokens(
  userId: string,
  accountId: string,
  newTokens: GoogleTokens,
): Promise<void> {
  const decision = decideRefreshTokenWrite(newTokens);
  if (!decision.write) return;
  if (decision.mode === "rotate") {
    // The old refresh token is revoked the moment Google issues a new one.
    await saveRefreshedDriveTokens(userId, accountId, {
      accessToken: decision.accessTokenPlain,
      refreshToken: decision.refreshTokenPlain,
      expiresAt: decision.expiresAt,
      onlyIfNewer: false,
    });
    return;
  }
  await saveRefreshedDriveTokens(userId, accountId, {
    accessToken: decision.accessTokenPlain,
    expiresAt: decision.expiresAt,
    onlyIfNewer: true,
  });
}

/**
 * The OAuth2 client of one linked Google Drive account, from the row
 * drive/linked-drive-accounts.ts loaded (mirrors mail/gmail.ts's
 * buildLinkedCalendarClient). A token that cannot be decrypted, or a missing
 * refresh token (the link refuses a grant without one, so it is corruption),
 * answers null and flags the account for reconnect: only a re-link fixes it. A
 * refreshed token is saved encrypted, scoped by (id, userId).
 */
export function buildLinkedDriveClient(
  userId: string,
  account: DriveAccountCredentials,
): LinkedDriveClient | null {
  let accessToken = "";
  let refreshToken = "";
  try {
    accessToken = decryptToken(account.accessToken);
    refreshToken = decryptToken(account.refreshToken);
  } catch {
    console.warn(`[GOOGLE-DRIVE] Skipping drive account ${account.id}: token decrypt failed`);
    flagForReconnect(userId, account.id);
    return null;
  }
  if (!refreshToken) {
    console.warn(`[GOOGLE-DRIVE] Drive account ${account.id} has no refresh token: flagging`);
    flagForReconnect(userId, account.id);
    return null;
  }
  const oauth2 = getOAuth2Client();
  oauth2.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
    expiry_date: account.expiresAt ? account.expiresAt.getTime() : undefined,
  });
  oauth2.on("tokens", async (newTokens) => {
    try {
      await persistRefreshedDriveTokens(userId, account.id, newTokens);
    } catch (err) {
      console.error(
        `[GOOGLE-DRIVE] Failed to persist a refreshed drive token for user ${userId}:`,
        err instanceof Error ? err.message : err,
      );
      captureError(err, {
        tags: { scope: "drive.google.refresh_persist" },
        extra: { userId, accountId: account.id },
      });
    }
  });
  return { client: oauth2, id: account.id, email: account.email };
}

/**
 * A Google call of this account failed. A revoked grant (C2's
 * `isRevokedGrantError`: a 401, or invalid_grant / unauthorized_client) is the
 * account's condition, not a bug: the account is flagged for reconnect, so
 * refresh stops, and its rows stay until the user unlinks. True when it was
 * one; the caller still owns any other failure.
 */
export async function handleDriveGrantFailure(
  userId: string,
  accountId: string,
  err: unknown,
): Promise<boolean> {
  if (!isRevokedGrantError(err)) return false;
  await markDriveAccountForReconnect(userId, accountId).catch((markErr) => {
    console.error(
      `[GOOGLE-DRIVE] Failed to flag drive account ${accountId} for reconnect:`,
      markErr,
    );
    captureError(markErr, { tags: { scope: "drive.google.mark-reconnect" } });
  });
  return true;
}
