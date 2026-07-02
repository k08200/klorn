import { google } from "googleapis";
import { MULTI_INBOX_SYNC_ENABLED } from "./config.js";
import { decryptOptional, decryptToken, encryptOptional, encryptToken } from "./crypto-tokens.js";
import { prisma } from "./db.js";
import { getUserLlmCredentials } from "./llm-credentials.js";
import { captureError } from "./sentry.js";
import { wrapUntrusted } from "./untrusted.js";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI || "http://localhost:3001/api/auth/google/callback";

export interface GmailDraftAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

export interface GoogleConnectionStatus {
  connected: boolean;
  hasRefreshToken: boolean;
  expired: boolean;
  needsReconnect: boolean;
  reason:
    | "not_connected"
    | "missing_refresh_token"
    | "token_decryption_failed"
    | "provider_auth_failed"
    | null;
  gmailPushConfigured: boolean;
  gmailPushEnabled: boolean;
  gmailPushExpiresAt: Date | null;
}

export function getOAuth2Client(): InstanceType<typeof google.auth.OAuth2> {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

export function getAuthUrl(userId?: string) {
  const oauth2 = getOAuth2Client();
  return oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    state: userId || undefined,
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/calendar.events",
      // Read-only across ALL calendars: needed for calendarList.list + freebusy
      // (multi-calendar conflict detection). Existing tokens lack it and degrade
      // to primary-only until the user reconnects.
      "https://www.googleapis.com/auth/calendar.readonly",
    ],
  });
}

/** Google login OAuth URL — requests profile + email + Gmail + Calendar for one-click setup */
export function getLoginAuthUrl(signedState: string) {
  const oauth2 = getOAuth2Client();
  return oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    state: signedState,
    scope: [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/calendar.events",
      // Read-only across ALL calendars: needed for calendarList.list + freebusy
      // (multi-calendar conflict detection). Existing tokens lack it and degrade
      // to primary-only until the user reconnects.
      "https://www.googleapis.com/auth/calendar.readonly",
    ],
  });
}

/**
 * OAuth URL to link a SECONDARY Google account for calendar free/busy only.
 * Least-privilege: requests just calendar.readonly (+ openid/email to identify
 * which account was linked) — no Gmail, no calendar.events. This is what makes
 * the consent screen non-scary for a work account and keeps the linked token
 * unable to read mail or write events.
 */
export function getLinkCalendarAuthUrl(signedState: string) {
  const oauth2 = getOAuth2Client();
  return oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    state: signedState,
    scope: [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/calendar.readonly",
    ],
  });
}

/**
 * OAuth URL to link a SECONDARY Google account as a FULL INBOX (Pro feature).
 * Requests the same gmail scopes as the primary login (readonly/send/modify) so
 * the firewall can read, classify, and act on this account's mail — plus
 * openid/email to identify which account was linked. NO calendar scopes here:
 * an inbox link is mail-only (calendar linking is a separate least-privilege
 * flow). Reuses the app's already-verified scope set, so linking a second inbox
 * does NOT request any new Google scope and does not reopen CASA verification.
 */
export function getLinkInboxAuthUrl(signedState: string) {
  const oauth2 = getOAuth2Client();
  return oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    state: signedState,
    scope: [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.modify",
    ],
  });
}

/** Get Google user profile from access token */
export async function getGoogleUserInfo(
  accessToken: string,
): Promise<{ email: string; verified_email: boolean; name: string; picture: string }> {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error("Failed to fetch Google user info");
  // verified_email gates account linking on the login path — an unverified
  // Google email must NOT be trusted to resolve/link an existing account.
  return res.json() as Promise<{
    email: string;
    verified_email: boolean;
    name: string;
    picture: string;
  }>;
}

async function invalidateGoogleToken(
  token: { id: string; userId: string },
  reason: GoogleConnectionStatus["reason"],
): Promise<void> {
  // Guard — never mutate the prod token row from a non-prod environment.
  //
  // Why: this function is called whenever decryptToken() throws, and the
  // most common cause of that is a developer running a one-off script
  // (or a CI job) that hits the *prod* DATABASE_URL with a *local*
  // TOKEN_ENCRYPTION_KEY. The decrypt fails 100% of the time and the
  // function used to wipe the prod row, forcing the founder to reconnect
  // Google. Real cause was the env mismatch, not a stale token.
  //
  // Incident: 2026-06-01. A diagnostic script (klorn-briefing-prove.ts)
  // hit prod with a local key and silently invalidated the founder's
  // token at the moment of dogfood; google/status returned 500 and
  // every dependent surface (Run agent now, briefing push, learned
  // signals panel) broke for hours.
  //
  // Production keeps the original behaviour. Anywhere else we just log
  // loudly and leave the row alone — let the env owner notice and fix
  // their key, instead of breaking the real user.
  if (process.env.NODE_ENV !== "production" && process.env.RENDER !== "true") {
    console.warn(
      `[GOOGLE] invalidateGoogleToken called from non-prod env for user ${token.userId} (reason=${reason}) — SKIPPING DB write to avoid corrupting prod token. Check your TOKEN_ENCRYPTION_KEY matches the DB you're pointed at.`,
    );
    return;
  }

  await prisma.userToken
    .update({
      where: { id: token.id },
      data: {
        accessToken: "",
        refreshToken: null,
        expiresAt: new Date(0),
        gmailWatchExpiresAt: null,
      },
    })
    .catch(() => null);
  console.warn(`[GOOGLE] Token for user ${token.userId} marked for reconnect: ${reason}`);
}

export function isGoogleAuthError(err: unknown): boolean {
  const gaxiosErr = err as {
    response?: {
      status?: number;
      data?: { error?: string | { message?: string; status?: string } };
    };
    code?: string | number;
    message?: string;
  };
  const status = gaxiosErr.response?.status;
  const rawError = gaxiosErr.response?.data?.error;
  const errorCode =
    typeof rawError === "string" ? rawError : rawError?.status || String(gaxiosErr.code ?? "");
  const message =
    (typeof rawError === "object" ? rawError?.message : "") || gaxiosErr.message || "";
  return (
    status === 401 ||
    /invalid[_ ]grant|invalid[_ ]token|unauthorized|expired|revoked/i.test(errorCode) ||
    /invalid[_ ]grant|invalid[_ ]token|unauthorized|expired|revoked/i.test(message)
  );
}

/**
 * A 404/410 from the Gmail API for a single message: it was deleted, trashed,
 * or expunged between a `messages.list` and the follow-up `messages.get`. This
 * is an expected race during sync/reconcile — skip that message, don't treat it
 * as a failure or abort the surrounding batch.
 */
export function isGoogleNotFoundError(err: unknown): boolean {
  const gaxiosErr = err as { response?: { status?: number }; code?: string | number };
  const status = gaxiosErr.response?.status ?? gaxiosErr.code;
  return status === 404 || status === 410;
}

export async function markGoogleTokenForReconnect(
  userId: string,
  reason: GoogleConnectionStatus["reason"] = "provider_auth_failed",
): Promise<void> {
  const token = await prisma.userToken.findFirst({
    where: { userId, provider: "google" },
    select: { id: true, userId: true },
  });
  if (token) await invalidateGoogleToken(token, reason);
}

export async function getGoogleConnectionStatus(userId: string): Promise<GoogleConnectionStatus> {
  const token = await prisma.userToken.findFirst({
    where: { userId, provider: "google" },
  });
  const gmailPushConfigured = !!process.env.GMAIL_PUBSUB_TOPIC;
  if (!token) {
    return {
      connected: false,
      hasRefreshToken: false,
      expired: false,
      needsReconnect: false,
      reason: "not_connected",
      gmailPushConfigured,
      gmailPushEnabled: false,
      gmailPushExpiresAt: null,
    };
  }

  try {
    if (token.accessToken) decryptToken(token.accessToken);
    if (token.refreshToken) decryptOptional(token.refreshToken);
  } catch {
    await invalidateGoogleToken(token, "token_decryption_failed");
    return {
      connected: false,
      hasRefreshToken: false,
      expired: true,
      needsReconnect: true,
      reason: "token_decryption_failed",
      gmailPushConfigured,
      gmailPushEnabled: false,
      gmailPushExpiresAt: null,
    };
  }

  const hasRefreshToken = !!token.refreshToken;
  const expired = token.expiresAt ? token.expiresAt.getTime() < Date.now() : false;
  const watchExpiresAt = (token as unknown as { gmailWatchExpiresAt?: Date | null })
    .gmailWatchExpiresAt;
  const gmailPushEnabled = !!(watchExpiresAt && watchExpiresAt.getTime() > Date.now());

  return {
    connected: hasRefreshToken,
    hasRefreshToken,
    expired,
    needsReconnect: !hasRefreshToken,
    reason: hasRefreshToken ? null : "missing_refresh_token",
    gmailPushConfigured,
    gmailPushEnabled,
    gmailPushExpiresAt: watchExpiresAt ?? null,
  };
}

export async function getAuthedClient(
  userId: string,
): Promise<InstanceType<typeof google.auth.OAuth2> | null> {
  const token = await prisma.userToken.findFirst({
    where: { userId, provider: "google" },
  });

  if (!token) return null;

  let accessTokenPlain = "";
  let refreshTokenPlain: string | null = null;
  try {
    accessTokenPlain = token.accessToken ? decryptToken(token.accessToken) : "";
    refreshTokenPlain = decryptOptional(token.refreshToken);
  } catch {
    await invalidateGoogleToken(token, "token_decryption_failed");
    return null;
  }

  // Must have a refresh_token to maintain long-lived connection
  if (!refreshTokenPlain) {
    const isExpired = token.expiresAt && token.expiresAt.getTime() < Date.now();
    if (isExpired || !accessTokenPlain) {
      console.warn(
        `[GOOGLE] No refresh_token and token expired for user ${userId} — needs reconnect`,
      );
      return null;
    }
    console.warn(
      `[GOOGLE] No refresh_token for user ${userId} — token will expire and sync will fail`,
    );
  }

  const oauth2 = getOAuth2Client();
  oauth2.setCredentials({
    access_token: accessTokenPlain,
    refresh_token: refreshTokenPlain,
    expiry_date: token.expiresAt ? token.expiresAt.getTime() : undefined,
  });

  // Auto-refresh expired tokens — persist BOTH access and refresh tokens (encrypted at rest).
  // Uses optimistic locking against expiresAt so a slower concurrent refresh cannot clobber
  // a newer one already written by a parallel request. Refresh-token rotation writes
  // unconditionally because Google revokes the old refresh_token the moment a new one is issued.
  oauth2.on("tokens", async (newTokens) => {
    try {
      await persistRefreshedGoogleToken(token.id, userId, newTokens);
    } catch (err) {
      console.error(
        `[GOOGLE] Failed to persist refreshed token for user ${userId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  });

  return oauth2;
}

export type RefreshTokenDecision =
  | { write: false; reason: "noop_empty_callback" | "noop_no_expiry" }
  | {
      write: true;
      mode: "rotate";
      accessTokenPlain: string;
      refreshTokenPlain: string;
      expiresAt: Date | null;
    }
  | {
      write: true;
      mode: "optimistic";
      accessTokenPlain: string;
      expiresAt: Date;
    };

/**
 * Pure decision function — given a Google `oauth2.on("tokens")` payload, decide
 * what (if anything) should be persisted. Exported for unit tests.
 *
 * - Rotation (new refresh_token present) MUST be persisted unconditionally; the
 *   old refresh_token is revoked the instant Google issues a new one.
 * - Otherwise we treat the write as optimistic against the stored expiry —
 *   skipped if a later expiry has already been written, so a stale concurrent
 *   refresh cannot win the race.
 */
export function decideRefreshTokenWrite(newTokens: {
  access_token?: string | null;
  refresh_token?: string | null;
  expiry_date?: number | null;
}): RefreshTokenDecision {
  if (!newTokens.access_token && !newTokens.refresh_token) {
    return { write: false, reason: "noop_empty_callback" };
  }

  const expiresAt = newTokens.expiry_date ? new Date(newTokens.expiry_date) : null;
  const access = newTokens.access_token ?? "";

  if (newTokens.refresh_token) {
    return {
      write: true,
      mode: "rotate",
      accessTokenPlain: access,
      refreshTokenPlain: newTokens.refresh_token,
      expiresAt,
    };
  }

  if (!expiresAt) {
    return { write: false, reason: "noop_no_expiry" };
  }

  return {
    write: true,
    mode: "optimistic",
    accessTokenPlain: access,
    expiresAt,
  };
}

async function persistRefreshedGoogleToken(
  tokenId: string,
  userId: string,
  newTokens: {
    access_token?: string | null;
    refresh_token?: string | null;
    expiry_date?: number | null;
  },
): Promise<void> {
  const decision = decideRefreshTokenWrite(newTokens);
  if (!decision.write) return;

  if (decision.mode === "rotate") {
    await prisma.userToken.update({
      where: { id: tokenId },
      data: {
        accessToken: encryptToken(decision.accessTokenPlain),
        refreshToken: encryptOptional(decision.refreshTokenPlain),
        expiresAt: decision.expiresAt,
      },
    });
    console.log(`[GOOGLE] Token refreshed for user ${userId} (new refresh_token saved)`);
    return;
  }

  // optimistic: only overwrite when our new expiry is strictly later than what's stored
  const result = await prisma.userToken.updateMany({
    where: {
      id: tokenId,
      OR: [{ expiresAt: null }, { expiresAt: { lt: decision.expiresAt } }],
    },
    data: {
      accessToken: encryptToken(decision.accessTokenPlain),
      expiresAt: decision.expiresAt,
    },
  });

  if (result.count === 0) {
    console.log(
      `[GOOGLE] Skipped stale token write for user ${userId} (newer token already stored)`,
    );
  } else {
    console.log(`[GOOGLE] Token refreshed for user ${userId}`);
  }
}

/**
 * OAuth2 clients for every SECONDARY calendar account the user linked. Mirrors
 * getAuthedClient (decrypt + auto-refresh) but returns one client per
 * LinkedCalendarAccount row, tagged with its email. A row whose token can't be
 * decrypted is skipped, not fatal — the primary account and the other linked
 * accounts still work. Read only by checkConflicts.
 */
export async function getLinkedCalendarClients(
  userId: string,
): Promise<Array<{ client: InstanceType<typeof google.auth.OAuth2>; id: string; email: string }>> {
  const rows = await prisma.linkedCalendarAccount.findMany({ where: { userId } });
  const clients: Array<{
    client: InstanceType<typeof google.auth.OAuth2>;
    id: string;
    email: string;
  }> = [];
  for (const row of rows) {
    let accessTokenPlain = "";
    let refreshTokenPlain: string | null = null;
    try {
      accessTokenPlain = row.accessToken ? decryptToken(row.accessToken) : "";
      refreshTokenPlain = decryptOptional(row.refreshToken);
    } catch {
      // Undecryptable token can only be fixed by a re-link — flag it (fire-and-
      // forget; this loop is sync) so the UI prompts a reconnect, then skip.
      console.warn(`[GOOGLE] Skipping linked calendar ${row.id} — token decrypt failed`);
      void markLinkedCalendarForReconnect(userId, row.id).catch((markErr) => {
        console.error(`[GOOGLE] Failed to flag linked calendar ${row.id} for reconnect:`, markErr);
        captureError(markErr, { tags: { scope: "gmail.linked-calendar.mark-reconnect" } });
      });
      continue;
    }
    if (!accessTokenPlain && !refreshTokenPlain) {
      // Empty tokens (corruption / prior invalidation): flag for reconnect so the
      // calendar surfaces a re-link prompt instead of silently dropping out of
      // free/busy (mirror of the decrypt-failure branch above).
      console.warn(`[GOOGLE] Linked calendar ${row.id} has empty tokens — flagging for reconnect`);
      void markLinkedCalendarForReconnect(userId, row.id).catch((markErr) => {
        console.error(`[GOOGLE] Failed to flag linked calendar ${row.id} for reconnect:`, markErr);
        captureError(markErr, { tags: { scope: "gmail.linked-calendar.mark-reconnect" } });
      });
      continue;
    }

    const oauth2 = getOAuth2Client();
    oauth2.setCredentials({
      access_token: accessTokenPlain,
      refresh_token: refreshTokenPlain,
      expiry_date: row.expiresAt ? row.expiresAt.getTime() : undefined,
    });
    oauth2.on("tokens", async (newTokens) => {
      try {
        await persistRefreshedLinkedToken(row.id, userId, newTokens);
      } catch (err) {
        console.error(
          `[GOOGLE] Failed to persist refreshed linked-calendar token for user ${userId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    });
    clients.push({ client: oauth2, id: row.id, email: row.email });
  }
  return clients;
}

async function persistRefreshedLinkedToken(
  rowId: string,
  userId: string,
  newTokens: {
    access_token?: string | null;
    refresh_token?: string | null;
    expiry_date?: number | null;
  },
): Promise<void> {
  const decision = decideRefreshTokenWrite(newTokens);
  if (!decision.write) {
    // A "tokens" callback with a usable access_token means the token is healthy
    // again even when we skip the DB persist (no expiry to reason about
    // staleness). Clear any stale needsReconnect so a re-authorized calendar
    // doesn't stay stuck showing "Reconnect needed". Best-effort.
    if (newTokens.access_token) {
      await prisma.linkedCalendarAccount
        .updateMany({ where: { id: rowId, userId }, data: { needsReconnect: false } })
        .catch((err) => {
          console.error(
            `[GOOGLE] Failed to clear reconnect flag for linked calendar ${rowId}:`,
            err instanceof Error ? err.message : err,
          );
        });
    }
    return;
  }

  // Both writes are scoped by { id, userId } (not id alone): the row id is a
  // UUID already filtered by userId in getLinkedCalendarClients, but scoping the
  // write too makes this function safe to reuse from any future call site and
  // can never touch another user's row.
  // A successful refresh means the token is healthy again — clear any stale
  // needsReconnect flag (mirror of persistRefreshedInboxToken).
  if (decision.mode === "rotate") {
    await prisma.linkedCalendarAccount.updateMany({
      where: { id: rowId, userId },
      data: {
        accessToken: encryptToken(decision.accessTokenPlain),
        refreshToken: encryptOptional(decision.refreshTokenPlain),
        expiresAt: decision.expiresAt,
        needsReconnect: false,
      },
    });
    return;
  }

  const result = await prisma.linkedCalendarAccount.updateMany({
    where: {
      id: rowId,
      userId,
      OR: [{ expiresAt: null }, { expiresAt: { lt: decision.expiresAt } }],
    },
    data: {
      accessToken: encryptToken(decision.accessTokenPlain),
      expiresAt: decision.expiresAt,
      needsReconnect: false,
    },
  });
  if (result.count === 0) {
    console.log(`[GOOGLE] Skipped stale linked-calendar token write for user ${userId}`);
  }
}

// ─── Linked (secondary) full inboxes — multi-account sync ─────────────────────
// Mirrors the linked-calendar client helpers above, but for LinkedInboxAccount
// (full gmail scopes). Kept separate from the primary getAuthedClient so the
// single-account UserToken path is never touched.

async function persistRefreshedInboxToken(
  rowId: string,
  userId: string,
  newTokens: {
    access_token?: string | null;
    refresh_token?: string | null;
    expiry_date?: number | null;
  },
): Promise<void> {
  const decision = decideRefreshTokenWrite(newTokens);
  if (!decision.write) {
    // A "tokens" callback with a usable access_token means the token is healthy
    // again even when we skip the DB persist. Clear any stale needsReconnect so a
    // re-authorized inbox doesn't stay stuck showing "Reconnect needed".
    if (newTokens.access_token) {
      await prisma.linkedInboxAccount
        .updateMany({ where: { id: rowId, userId }, data: { needsReconnect: false } })
        .catch((err) => {
          console.error(
            `[GOOGLE] Failed to clear reconnect flag for linked inbox ${rowId}:`,
            err instanceof Error ? err.message : err,
          );
        });
    }
    return;
  }
  // A successful refresh means the token is healthy again — clear any stale
  // needsReconnect flag so a previously-revoked inbox that the user re-authorized
  // stops showing the reconnect prompt without needing a full re-link.
  if (decision.mode === "rotate") {
    await prisma.linkedInboxAccount.updateMany({
      where: { id: rowId, userId },
      data: {
        accessToken: encryptToken(decision.accessTokenPlain),
        refreshToken: encryptOptional(decision.refreshTokenPlain),
        expiresAt: decision.expiresAt,
        needsReconnect: false,
      },
    });
    return;
  }
  const result = await prisma.linkedInboxAccount.updateMany({
    where: {
      id: rowId,
      userId,
      OR: [{ expiresAt: null }, { expiresAt: { lt: decision.expiresAt } }],
    },
    data: {
      accessToken: encryptToken(decision.accessTokenPlain),
      expiresAt: decision.expiresAt,
      needsReconnect: false,
    },
  });
  if (result.count === 0) {
    console.log(`[GOOGLE] Skipped stale linked-inbox token write for user ${userId}`);
  }
}

function buildInboxOAuthClient(
  row: { id: string; accessToken: string; refreshToken: string | null; expiresAt: Date | null },
  userId: string,
): InstanceType<typeof google.auth.OAuth2> | null {
  let accessTokenPlain = "";
  let refreshTokenPlain: string | null = null;
  try {
    accessTokenPlain = row.accessToken ? decryptToken(row.accessToken) : "";
    refreshTokenPlain = decryptOptional(row.refreshToken);
  } catch (err) {
    // A permanently undecryptable linked token (key rotation / at-rest
    // corruption) can only be fixed by a re-link, so flag it for reconnect AND
    // surface it to an operator. Fire-and-forget (this fn is sync) but never
    // silent on failure of the flag write itself.
    console.warn(`[GOOGLE] Skipping linked inbox ${row.id} — token decrypt failed`);
    captureError(err, {
      tags: { scope: "gmail.linked-inbox.decrypt" },
      extra: { rowId: row.id, userId },
    });
    void markLinkedInboxForReconnect(userId, row.id).catch((markErr) => {
      console.error(`[GOOGLE] Failed to flag linked inbox ${row.id} for reconnect:`, markErr);
      captureError(markErr, { tags: { scope: "gmail.linked-inbox.mark-reconnect" } });
    });
    return null;
  }
  if (!accessTokenPlain && !refreshTokenPlain) {
    // Both tokens decrypted to empty (at-rest corruption / prior invalidation):
    // the inbox can't sync and only a re-link fixes it. Flag it so the UI prompts
    // a reconnect instead of the inbox silently vanishing from the sync fan-out
    // (mirror of the decrypt-failure branch above).
    console.warn(`[GOOGLE] Linked inbox ${row.id} has empty tokens — flagging for reconnect`);
    void markLinkedInboxForReconnect(userId, row.id).catch((markErr) => {
      console.error(`[GOOGLE] Failed to flag linked inbox ${row.id} for reconnect:`, markErr);
      captureError(markErr, { tags: { scope: "gmail.linked-inbox.mark-reconnect" } });
    });
    return null;
  }

  const oauth2 = getOAuth2Client();
  oauth2.setCredentials({
    access_token: accessTokenPlain,
    refresh_token: refreshTokenPlain,
    expiry_date: row.expiresAt ? row.expiresAt.getTime() : undefined,
  });
  oauth2.on("tokens", async (newTokens) => {
    try {
      await persistRefreshedInboxToken(row.id, userId, newTokens);
    } catch (err) {
      console.error(
        `[GOOGLE] Failed to persist refreshed linked-inbox token for user ${userId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  });
  return oauth2;
}

/**
 * One OAuth2 client per LINKED (secondary) full inbox, for multi-account sync.
 * A corrupt/undecryptable row is skipped, never fatal, so one bad linked inbox
 * can't break sync for the primary or the other linked accounts. Returns the
 * row id + email alongside the client so the caller can attribute synced mail
 * (EmailMessage.linkedInboxAccountId).
 */
export async function getLinkedInboxClients(
  userId: string,
): Promise<Array<{ client: InstanceType<typeof google.auth.OAuth2>; id: string; email: string }>> {
  const rows = await prisma.linkedInboxAccount.findMany({ where: { userId } });
  const clients: Array<{
    client: InstanceType<typeof google.auth.OAuth2>;
    id: string;
    email: string;
  }> = [];
  for (const row of rows) {
    const client = buildInboxOAuthClient(row, userId);
    if (client) clients.push({ client, id: row.id, email: row.email });
  }
  return clients;
}

/**
 * OAuth2 client for ONE linked inbox (by row id, scoped to userId). Used to act
 * on mail that was synced from a specific secondary inbox (e.g. archive/reply).
 * Returns null if the row is missing or its token is unusable.
 */
export async function getAuthedInboxClient(
  userId: string,
  linkedInboxAccountId: string,
): Promise<InstanceType<typeof google.auth.OAuth2> | null> {
  const row = await prisma.linkedInboxAccount.findFirst({
    where: { id: linkedInboxAccountId, userId },
  });
  if (!row) return null;
  return buildInboxOAuthClient(row, userId);
}

/**
 * Resolve ONE linked inbox's OAuth client together with its address and id, for
 * a single-message re-sync (undo after untrash/unarchive) that must fetch from
 * and stamp against the linked account — not the primary, where the message id
 * does not exist. Returns null if the row is missing or its token is unusable.
 */
export async function getAuthedInboxAccount(
  userId: string,
  linkedInboxAccountId: string,
): Promise<{ client: InstanceType<typeof google.auth.OAuth2>; id: string; email: string } | null> {
  const row = await prisma.linkedInboxAccount.findFirst({
    where: { id: linkedInboxAccountId, userId },
  });
  if (!row) return null;
  const client = buildInboxOAuthClient(row, userId);
  if (!client) return null;
  return { client, id: row.id, email: row.email };
}

/**
 * Resolve the Gmail OAuth client to ACT on a message: the primary account by
 * default, or a specific linked secondary inbox when the message belongs to one
 * (EmailMessage.linkedInboxAccountId). This is what makes multi-account actions
 * (archive/read/star/trash) hit the right account instead of always the primary.
 */
async function resolveMailClient(
  userId: string,
  linkedInboxAccountId?: string | null,
): Promise<InstanceType<typeof google.auth.OAuth2> | null> {
  return linkedInboxAccountId
    ? getAuthedInboxClient(userId, linkedInboxAccountId)
    : getAuthedClient(userId);
}

/**
 * Durably flag ONE linked inbox as needing a re-link (its token is revoked or
 * undecryptable). Scoped by {id, userId} so it can only touch the caller's own
 * linked account. Cleared on a successful token refresh or re-link. This is what
 * turns a silently-rotting linked inbox into a visible "Reconnect" prompt — at
 * scale, revoked linked tokens are routine, not an edge case.
 */
export async function markLinkedInboxForReconnect(
  userId: string,
  linkedInboxAccountId: string,
): Promise<void> {
  await prisma.linkedInboxAccount.updateMany({
    where: { id: linkedInboxAccountId, userId },
    data: { needsReconnect: true },
  });
}

/**
 * Durably flag ONE linked CALENDAR as needing a re-link (token revoked or
 * undecryptable). Scoped by {id, userId}. Cleared on a successful token refresh
 * or re-link. Mirror of markLinkedInboxForReconnect — a revoked linked calendar
 * would otherwise silently drop out of free/busy with no user-visible signal.
 */
export async function markLinkedCalendarForReconnect(
  userId: string,
  linkedCalendarAccountId: string,
): Promise<void> {
  await prisma.linkedCalendarAccount.updateMany({
    where: { id: linkedCalendarAccountId, userId },
    data: { needsReconnect: true },
  });
}

/**
 * Route a Gmail auth error to the RIGHT account. A linked-inbox failure must
 * never poison the primary connection (markGoogleTokenForReconnect is
 * userId-keyed) — it flags only that linked row; a primary failure flags the
 * primary token. Used by every mail action so a revoked account of either kind
 * surfaces a reconnect prompt instead of failing silently.
 */
async function markInboxForReconnect(
  userId: string,
  linkedInboxAccountId?: string | null,
): Promise<void> {
  if (linkedInboxAccountId) await markLinkedInboxForReconnect(userId, linkedInboxAccountId);
  else await markGoogleTokenForReconnect(userId);
}

// Gmail tool functions for Eve

export async function listEmails(userId: string, maxResults = 10) {
  const auth = await getAuthedClient(userId);
  if (!auth) return { error: "Gmail not connected. Please connect your Gmail first." };

  const gmail = google.gmail({ version: "v1", auth });
  const res = await gmail.users.messages.list({
    userId: "me",
    maxResults,
    labelIds: ["INBOX"],
  });

  const messages = res.data.messages || [];
  const emails = [];

  for (const msg of messages.slice(0, maxResults)) {
    const detail = await gmail.users.messages.get({
      userId: "me",
      id: msg.id ?? "",
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });

    const headers = detail.data.payload?.headers || [];
    emails.push({
      id: msg.id,
      from: headers.find((h) => h.name === "From")?.value || "",
      subject: wrapUntrusted(headers.find((h) => h.name === "Subject")?.value, "email:subject"),
      date: headers.find((h) => h.name === "Date")?.value || "",
      snippet: wrapUntrusted(detail.data.snippet, "email:snippet"),
      // Gmail's labelIds carries CATEGORY_PROMOTIONS / CATEGORY_UPDATES /
      // UNREAD / IMPORTANT — high-signal hints for the classifier.
      labels: detail.data.labelIds || [],
    });
  }

  return { emails };
}

export async function readEmail(userId: string, emailId: string) {
  const auth = await getAuthedClient(userId);
  if (!auth) return { error: "Gmail not connected." };

  const gmail = google.gmail({ version: "v1", auth });
  const res = await gmail.users.messages.get({
    userId: "me",
    id: emailId,
    format: "full",
  });

  const headers = res.data.payload?.headers || [];
  const parts = res.data.payload?.parts || [];

  let body = "";
  const textPart = parts.find((p) => p.mimeType === "text/plain");
  if (textPart?.body?.data) {
    body = Buffer.from(textPart.body.data, "base64").toString("utf-8");
  } else if (res.data.payload?.body?.data) {
    body = Buffer.from(res.data.payload.body.data, "base64").toString("utf-8");
  }

  return {
    id: emailId,
    from: headers.find((h) => h.name === "From")?.value || "",
    to: headers.find((h) => h.name === "To")?.value || "",
    subject: wrapUntrusted(headers.find((h) => h.name === "Subject")?.value, "email:subject"),
    date: headers.find((h) => h.name === "Date")?.value || "",
    body: wrapUntrusted(body, "email:body"),
  };
}

/** RFC 5321 hard limit — reject before any parsing to keep validation O(1). */
const MAX_RECIPIENT_LENGTH = 320;

/**
 * Loose email address validator — we only need to catch agent hallucinations
 * where `to` is a bare domain ("accounts.google.com") or otherwise clearly not
 * an address. Gmail itself does strict RFC validation on send. Implemented
 * with string ops rather than regex because `to` is LLM-generated and we
 * want no regex backtracking on adversarial inputs (CodeQL js/polynomial-redos).
 */
function extractAddress(raw: string): string {
  const trimmed = raw.trim();
  // "Name <addr@host>" form — take whatever is inside the final angle brackets
  if (trimmed.endsWith(">")) {
    const open = trimmed.lastIndexOf("<");
    if (open !== -1) return trimmed.slice(open + 1, -1).trim();
  }
  return trimmed;
}

function looksLikeEmailAddress(raw: string): boolean {
  if (raw.length > MAX_RECIPIENT_LENGTH) return false;
  const addr = extractAddress(raw);
  if (addr.length === 0 || addr.length > MAX_RECIPIENT_LENGTH) return false;
  const at = addr.indexOf("@");
  if (at <= 0 || at !== addr.lastIndexOf("@")) return false; // need exactly one @, not at start
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  if (local.length === 0 || domain.length === 0) return false;
  if (!domain.includes(".")) return false;
  // No whitespace in either part
  for (const part of [local, domain]) {
    for (let i = 0; i < part.length; i++) {
      const ch = part.charCodeAt(i);
      if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) return false;
    }
  }
  return true;
}

/** Local-parts / subdomains that should never receive an auto-reply — responses
 *  either bounce or land in an unmonitored inbox (security-alert /
 *  transactional domains). Matched against extracted address parts, not the
 *  raw input, so there's no regex-on-user-input risk. */
const NO_REPLY_TOKENS = [
  "no-reply",
  "noreply",
  "do-not-reply",
  "donotreply",
  "mailer-daemon",
  "postmaster",
  "notification",
  "notifications",
  "alert",
  "alerts",
  "security",
];

export function isNoReplyAddress(raw: string): boolean {
  const addr = extractAddress(raw).toLowerCase();
  const at = addr.indexOf("@");
  if (at === -1) return false;
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  // Check local-part exact match OR any leading subdomain label
  if (NO_REPLY_TOKENS.includes(local)) return true;
  for (const label of domain.split(".")) {
    if (NO_REPLY_TOKENS.includes(label)) return true;
  }
  return false;
}

function encodeSubject(subject: string): string {
  return `=?UTF-8?B?${Buffer.from(safeHeaderValue(subject)).toString("base64")}?=`;
}

function safeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function wrapBase64(value: string): string {
  return value.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

function safeAsciiFilename(filename: string): string {
  const fallback = filename
    .replace(/[\r\n"]/g, "")
    .replace(/[^\x20-\x7E]+/g, "_")
    .trim();
  return fallback || "attachment";
}

/**
 * Reduce a client-supplied attachment Content-Type to a clean RFC 2045
 * type/subtype token. `mimeType` is the only attachment value that reaches a
 * MIME header without sanitization; busboy already strips CR/LF (sub-part
 * headers are line-delimited), but this drops parameters, quotes, and any
 * non-token characters so a malformed upload type can't shape the header we
 * emit. Falls back to a safe default when the value isn't a valid type/subtype.
 */
export function safeMimeType(raw: string): string {
  const token = safeHeaderValue(raw).split(";")[0].trim().toLowerCase();
  const cleaned = token.replace(/[^a-z0-9!#$&^_.+/-]/g, "");
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(cleaned)
    ? cleaned
    : "application/octet-stream";
}

function buildPlainTextRawEmail(
  to: string,
  subject: string,
  body: string,
  attachments: GmailDraftAttachment[] = [],
): string {
  if (attachments.length === 0) {
    return Buffer.from(
      [
        `To: ${safeHeaderValue(to)}`,
        `Subject: ${encodeSubject(subject)}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        body,
      ].join("\r\n"),
    ).toString("base64url");
  }

  const boundary = `klorn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const parts = [
    `To: ${safeHeaderValue(to)}`,
    `Subject: ${encodeSubject(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
  ];

  for (const attachment of attachments) {
    const filename = safeHeaderValue(attachment.filename || "attachment");
    const asciiFilename = safeAsciiFilename(filename);
    parts.push(
      `--${boundary}`,
      `Content-Type: ${safeMimeType(attachment.mimeType)}; name="${asciiFilename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "",
      wrapBase64(attachment.content.toString("base64")),
    );
  }

  parts.push(`--${boundary}--`, "");
  return Buffer.from(parts.join("\r\n")).toString("base64url");
}

export async function sendEmail(
  userId: string,
  to: string,
  subject: string,
  body: string,
  attachments: GmailDraftAttachment[] = [],
) {
  // Single recipient only. A comma or semicolon means multiple addresses —
  // reject it so the angle-bracket display-name trick
  // (`a@x.com, evil@y.com <legit@z.com>`, whose addr-spec passes the check
  // below) can't smuggle an extra recipient into the To header.
  if (to.includes(",") || to.includes(";")) {
    return { error: "Send to one recipient at a time (no commas or semicolons in the address)." };
  }
  if (!looksLikeEmailAddress(to)) {
    return {
      error: `Invalid email address: "${to}". Use a full address like local@domain, not a domain such as accounts.google.com.`,
    };
  }
  if (isNoReplyAddress(to)) {
    return {
      error: `This address (${to}) is a no-reply system sender, so Klorn will not send a reply.`,
    };
  }

  const auth = await getAuthedClient(userId);
  if (!auth) return { error: "Gmail not connected." };

  const gmail = google.gmail({ version: "v1", auth });

  const raw = buildPlainTextRawEmail(to, subject, body, attachments);

  let res: { data: { id?: string | null } };
  try {
    res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });
  } catch (err) {
    if (isGoogleAuthError(err)) {
      await markGoogleTokenForReconnect(userId);
      return { error: "Gmail not connected. Please reconnect your Google account." };
    }
    throw err;
  }

  return { success: true, messageId: res.data.id };
}

export async function createEmailDraft(
  userId: string,
  to: string,
  subject: string,
  body: string,
  threadId?: string | null,
  attachments: GmailDraftAttachment[] = [],
) {
  if (!looksLikeEmailAddress(to)) {
    return {
      error: `Invalid email address: "${to}". Use a full address like local@domain, not a domain such as accounts.google.com.`,
    };
  }
  if (isNoReplyAddress(to)) {
    return {
      error: `This address (${to}) is a no-reply system sender. Klorn will not create a Gmail draft.`,
    };
  }

  const auth = await getAuthedClient(userId);
  if (!auth) return { error: "Gmail not connected." };

  const gmail = google.gmail({ version: "v1", auth });
  const raw = buildPlainTextRawEmail(to, subject, body, attachments);
  let res: { data: { id?: string | null; message?: { id?: string | null } | null } };
  try {
    res = await gmail.users.drafts.create({
      userId: "me",
      requestBody: {
        message: {
          raw,
          ...(threadId ? { threadId } : {}),
        },
      },
    });
  } catch (err) {
    if (isGoogleAuthError(err)) {
      await markGoogleTokenForReconnect(userId);
      return { error: "Gmail not connected. Please reconnect your Google account." };
    }
    throw err;
  }

  return {
    success: true,
    draftId: res.data.id,
    messageId: res.data.message?.id,
    url: "https://mail.google.com/mail/u/0/#drafts",
  };
}

/** Mark a Gmail message as read (remove UNREAD label) */
export async function markAsRead(
  userId: string,
  gmailMessageId: string,
  linkedInboxAccountId?: string | null,
) {
  const auth = await resolveMailClient(userId, linkedInboxAccountId);
  if (!auth) return { error: "Gmail not connected." };

  const gmail = google.gmail({ version: "v1", auth });
  try {
    await gmail.users.messages.modify({
      userId: "me",
      id: gmailMessageId,
      requestBody: { removeLabelIds: ["UNREAD"] },
    });
  } catch (err) {
    if (isGoogleAuthError(err)) {
      await markInboxForReconnect(userId, linkedInboxAccountId);
      return { error: "Gmail not connected. Please reconnect your Google account." };
    }
    throw err;
  }

  // Also update local DB
  await prisma.emailMessage.updateMany({
    where: { userId, gmailId: gmailMessageId },
    data: { isRead: true },
  });

  return { success: true };
}

/** Trash a Gmail message (move to Trash) */
export async function trashEmail(
  userId: string,
  gmailMessageId: string,
  linkedInboxAccountId?: string | null,
) {
  const auth = await resolveMailClient(userId, linkedInboxAccountId);
  if (!auth) return { error: "Gmail not connected." };

  const gmail = google.gmail({ version: "v1", auth });
  try {
    await gmail.users.messages.trash({ userId: "me", id: gmailMessageId });
  } catch (err) {
    if (isGoogleAuthError(err)) {
      await markInboxForReconnect(userId, linkedInboxAccountId);
      return { error: "Gmail not connected. Please reconnect your Google account." };
    }
    throw err;
  }

  await prisma.emailMessage.deleteMany({
    where: { userId, gmailId: gmailMessageId },
  });

  return { success: true };
}

/** Archive a Gmail message (remove INBOX label) */
export async function archiveEmail(
  userId: string,
  gmailMessageId: string,
  linkedInboxAccountId?: string | null,
) {
  const auth = await resolveMailClient(userId, linkedInboxAccountId);
  if (!auth) return { error: "Gmail not connected." };

  const gmail = google.gmail({ version: "v1", auth });
  try {
    await gmail.users.messages.modify({
      userId: "me",
      id: gmailMessageId,
      requestBody: { removeLabelIds: ["INBOX"] },
    });
  } catch (err) {
    if (isGoogleAuthError(err)) {
      await markInboxForReconnect(userId, linkedInboxAccountId);
      return { error: "Gmail not connected. Please reconnect your Google account." };
    }
    throw err;
  }

  await prisma.emailMessage.deleteMany({
    where: { userId, gmailId: gmailMessageId },
  });

  return { success: true };
}

/** Restore a Gmail message to the inbox */
export async function unarchiveEmail(
  userId: string,
  gmailMessageId: string,
  linkedInboxAccountId?: string | null,
) {
  const auth = await resolveMailClient(userId, linkedInboxAccountId);
  if (!auth) return { error: "Gmail not connected." };

  const gmail = google.gmail({ version: "v1", auth });
  try {
    await gmail.users.messages.modify({
      userId: "me",
      id: gmailMessageId,
      requestBody: { addLabelIds: ["INBOX"] },
    });
  } catch (err) {
    if (isGoogleAuthError(err)) {
      await markInboxForReconnect(userId, linkedInboxAccountId);
      return { error: "Gmail not connected. Please reconnect your Google account." };
    }
    throw err;
  }

  return { success: true };
}

/** Restore a Gmail message from trash */
export async function untrashEmail(
  userId: string,
  gmailMessageId: string,
  linkedInboxAccountId?: string | null,
) {
  const auth = await resolveMailClient(userId, linkedInboxAccountId);
  if (!auth) return { error: "Gmail not connected." };

  const gmail = google.gmail({ version: "v1", auth });
  try {
    await gmail.users.messages.untrash({ userId: "me", id: gmailMessageId });
  } catch (err) {
    if (isGoogleAuthError(err)) {
      await markInboxForReconnect(userId, linkedInboxAccountId);
      return { error: "Gmail not connected. Please reconnect your Google account." };
    }
    throw err;
  }

  return { success: true };
}

/** Toggle star on Gmail (add/remove STARRED label) */
export async function toggleStarGmail(
  userId: string,
  gmailMessageId: string,
  starred: boolean,
  linkedInboxAccountId?: string | null,
) {
  const auth = await resolveMailClient(userId, linkedInboxAccountId);
  if (!auth) return { error: "Gmail not connected." };

  const gmail = google.gmail({ version: "v1", auth });
  try {
    await gmail.users.messages.modify({
      userId: "me",
      id: gmailMessageId,
      requestBody: starred ? { addLabelIds: ["STARRED"] } : { removeLabelIds: ["STARRED"] },
    });
  } catch (err) {
    if (isGoogleAuthError(err)) {
      await markInboxForReconnect(userId, linkedInboxAccountId);
      return { error: "Gmail not connected. Please reconnect your Google account." };
    }
    throw err;
  }

  await prisma.emailMessage.updateMany({
    where: { userId, gmailId: gmailMessageId },
    data: { isStarred: starred },
  });

  return { success: true };
}

/** Toggle read/unread on Gmail */
export async function toggleReadGmail(
  userId: string,
  gmailMessageId: string,
  isRead: boolean,
  linkedInboxAccountId?: string | null,
) {
  const auth = await resolveMailClient(userId, linkedInboxAccountId);
  if (!auth) return { error: "Gmail not connected." };

  const gmail = google.gmail({ version: "v1", auth });
  try {
    await gmail.users.messages.modify({
      userId: "me",
      id: gmailMessageId,
      requestBody: isRead ? { removeLabelIds: ["UNREAD"] } : { addLabelIds: ["UNREAD"] },
    });
  } catch (err) {
    if (isGoogleAuthError(err)) {
      await markInboxForReconnect(userId, linkedInboxAccountId);
      return { error: "Gmail not connected. Please reconnect your Google account." };
    }
    throw err;
  }

  await prisma.emailMessage.updateMany({
    where: { userId, gmailId: gmailMessageId },
    data: { isRead },
  });

  return { success: true };
}

export async function classifyEmails(userId: string, maxResults = 10) {
  const result = await listEmails(userId, maxResults);
  if ("error" in result) return result;

  const { classifyEmailBatch, sortByPriority } = await import("./email-classifier.js");
  // BYOK: this user's classify-tool run bills their own key when set.
  const credentials = await getUserLlmCredentials(userId);
  const labels = await classifyEmailBatch(
    result.emails.map((e) => ({
      id: e.id,
      from: e.from || "",
      subject: e.subject || "",
      snippet: e.snippet || "",
      labels: e.labels,
    })),
    userId,
    credentials,
  );

  const classified = result.emails.map((email, i) => ({
    ...email,
    priority: labels[i].priority,
    category: labels[i].category,
    needsReply: labels[i].needsReply,
    reason: labels[i].reason,
  }));

  const sorted = sortByPriority(classified);

  const summary = {
    high: sorted.filter((e) => e.priority === "high").length,
    medium: sorted.filter((e) => e.priority === "medium").length,
    low: sorted.filter((e) => e.priority === "low").length,
  };

  return { emails: sorted, summary };
}

// ─── Push Notifications (Gmail watch + Pub/Sub) ──────────────────────────

/**
 * Register a Gmail push watch so Google posts INBOX changes to the configured
 * Pub/Sub topic. Requires GMAIL_PUBSUB_TOPIC env var in the form
 * "projects/<gcp-project>/topics/<topic>". The Gmail service account
 * (gmail-api-push@system.gserviceaccount.com) must have
 * roles/pubsub.publisher on the topic — see ops docs / GCP console.
 *
 * Watches expire after 7 days and must be renewed by calling this again.
 * The expiration is persisted on UserToken.gmailWatchExpiresAt so the
 * renewal cron can find watches approaching expiry.
 * Returns { historyId, expiration } on success.
 */
export async function registerGmailWatch(
  userId: string,
): Promise<{ historyId: string; expiration: string } | { error: string }> {
  const topic = process.env.GMAIL_PUBSUB_TOPIC;
  if (!topic) return { error: "GMAIL_PUBSUB_TOPIC not configured" };

  const auth = await getAuthedClient(userId);
  if (!auth) return { error: "Gmail not connected" };

  const gmail = google.gmail({ version: "v1", auth });
  try {
    const res = await gmail.users.watch({
      userId: "me",
      requestBody: {
        topicName: topic,
        labelIds: ["INBOX"],
        labelFilterBehavior: "INCLUDE",
      },
    });
    const expirationMs = res.data.expiration ? Number(res.data.expiration) : null;
    if (expirationMs && !Number.isNaN(expirationMs)) {
      await prisma.userToken.updateMany({
        where: { userId, provider: "google" },
        data: { gmailWatchExpiresAt: new Date(expirationMs) },
      });
    }
    return {
      historyId: String(res.data.historyId ?? ""),
      expiration: String(res.data.expiration ?? ""),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Gmail watch failed: ${msg}` };
  }
}

/** Stop the Gmail push watch for a user. Idempotent. */
export async function stopGmailWatch(userId: string): Promise<{ ok: boolean; error?: string }> {
  const auth = await getAuthedClient(userId);
  if (!auth) return { ok: false, error: "Gmail not connected" };

  const gmail = google.gmail({ version: "v1", auth });
  try {
    await gmail.users.stop({ userId: "me" });
    await prisma.userToken.updateMany({
      where: { userId, provider: "google" },
      data: { gmailWatchExpiresAt: null },
    });
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

/**
 * Renew Gmail watches that are about to expire (within 24h). Safe to call
 * repeatedly — users.watch is idempotent and extends the expiration.
 * Skipped when GMAIL_PUBSUB_TOPIC is not configured.
 */
export async function renewExpiringGmailWatches(): Promise<{ renewed: number; failed: number }> {
  if (!process.env.GMAIL_PUBSUB_TOPIC) return { renewed: 0, failed: 0 };

  const cutoff = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const tokens = await prisma.userToken.findMany({
    where: {
      provider: "google",
      gmailWatchExpiresAt: { not: null, lte: cutoff },
    },
    select: { userId: true },
  });

  let renewed = 0;
  let failed = 0;
  for (const t of tokens) {
    const result = await registerGmailWatch(t.userId);
    if ("error" in result) {
      console.warn(`[GMAIL-WATCH] Renew failed for ${t.userId}: ${result.error}`);
      // A lapsed watch means real-time email push silently dies for this
      // user — that must page the operator, not vanish into stdout.
      captureError(new Error(`Gmail watch renew failed: ${result.error}`), {
        tags: { scope: "gmail-watch.renew" },
        extra: { userId: t.userId },
      });
      failed++;
    } else {
      renewed++;
    }
  }

  // Multi-account: renew (and first-time register, when gmailWatchExpiresAt is
  // null) real-time push watches for LINKED secondary inboxes too. Without this
  // a linked inbox's watch silently expires after ~7 days and it degrades to
  // polling-only with no signal. Gated on MULTI_INBOX_SYNC_ENABLED so no linked
  // watches exist while the feature is off.
  if (MULTI_INBOX_SYNC_ENABLED) {
    const linked = await prisma.linkedInboxAccount.findMany({
      // Skip inboxes already flagged for reconnect: their token is revoked, so a
      // watch call can only 401. Without this a revoked inbox retries every hour
      // forever (the primary path self-limits because invalidateGoogleToken nulls
      // its gmailWatchExpiresAt; a linked flag doesn't touch that column). They
      // re-enter this query once a re-link clears needsReconnect.
      where: {
        needsReconnect: false,
        OR: [{ gmailWatchExpiresAt: null }, { gmailWatchExpiresAt: { lte: cutoff } }],
      },
      select: { id: true, userId: true },
    });
    for (const row of linked) {
      const result = await registerLinkedInboxWatch(row.userId, row.id);
      if ("error" in result) {
        console.warn(
          `[GMAIL-WATCH] Linked renew failed for ${row.userId}/${row.id}: ${result.error}`,
        );
        captureError(new Error(`Linked inbox watch renew failed: ${result.error}`), {
          tags: { scope: "gmail-watch.renew-linked" },
          extra: { userId: row.userId, linkedInboxAccountId: row.id },
        });
        failed++;
      } else {
        renewed++;
      }
    }
  }

  return { renewed, failed };
}

/**
 * Register a Gmail push watch for ONE linked secondary inbox, storing the
 * expiration on its LinkedInboxAccount row. Mirrors registerGmailWatch but via
 * the linked account's own OAuth client. Idempotent (users.watch extends).
 */
export async function registerLinkedInboxWatch(
  userId: string,
  linkedInboxAccountId: string,
): Promise<{ historyId: string; expiration: string } | { error: string }> {
  const topic = process.env.GMAIL_PUBSUB_TOPIC;
  if (!topic) return { error: "GMAIL_PUBSUB_TOPIC not configured" };

  const auth = await getAuthedInboxClient(userId, linkedInboxAccountId);
  if (!auth) return { error: "Linked inbox not connected" };

  const gmail = google.gmail({ version: "v1", auth });
  try {
    const res = await gmail.users.watch({
      userId: "me",
      requestBody: { topicName: topic, labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE" },
    });
    const expirationMs = res.data.expiration ? Number(res.data.expiration) : null;
    if (expirationMs && !Number.isNaN(expirationMs)) {
      await prisma.linkedInboxAccount.updateMany({
        where: { id: linkedInboxAccountId, userId },
        data: { gmailWatchExpiresAt: new Date(expirationMs) },
      });
    }
    return {
      historyId: String(res.data.historyId ?? ""),
      expiration: String(res.data.expiration ?? ""),
    };
  } catch (err: unknown) {
    // A revoked linked token 401s here. Flag it for reconnect so (a) the UI
    // prompts a re-link and (b) renewExpiringGmailWatches skips it next tick —
    // otherwise a revoked inbox retries watch registration every hour forever,
    // spamming Sentry + burning Gmail quota as revoked inboxes accumulate.
    // Best-effort: a DB blip in the flag-write must not prevent the {error}
    // return (the renewal loop reads it to count/continue per account).
    if (isGoogleAuthError(err)) {
      await markLinkedInboxForReconnect(userId, linkedInboxAccountId).catch((markErr) => {
        console.error(
          `[GMAIL-WATCH] Failed to flag linked inbox ${linkedInboxAccountId} for reconnect:`,
          markErr,
        );
        captureError(markErr, { tags: { scope: "gmail-watch.mark-reconnect" } });
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Linked inbox watch failed: ${msg}` };
  }
}

/** Stop the Gmail push watch for one linked inbox. Idempotent. */
export async function stopLinkedInboxWatch(
  userId: string,
  linkedInboxAccountId: string,
): Promise<{ ok: boolean; error?: string }> {
  const auth = await getAuthedInboxClient(userId, linkedInboxAccountId);
  if (!auth) return { ok: false, error: "Linked inbox not connected" };

  const gmail = google.gmail({ version: "v1", auth });
  try {
    await gmail.users.stop({ userId: "me" });
    await prisma.linkedInboxAccount.updateMany({
      where: { id: linkedInboxAccountId, userId },
      data: { gmailWatchExpiresAt: null },
    });
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

// ── Activity-driven watch self-heal ────────────────────────────────────────
// The hourly renewal tick lives in the in-process scheduler, which freezes
// whenever a free-tier dyno sleeps. If the process sleeps through the renewal
// window, the watch expires SILENTLY and Gmail stops pushing — the failure
// mode behind "my phone got no notifications for a week". This hook runs on
// user activity (firewall GET) instead, so the watch heals the moment the
// user opens the app, scheduler or not.
const watchEnsureLastRun = new Map<string, number>();
const WATCH_ENSURE_DEBOUNCE_MS = 10 * 60 * 1000;
const WATCH_RENEW_MARGIN_MS = 24 * 60 * 60 * 1000;

/**
 * Re-register the Gmail watch when it is expired or expiring within 24h.
 * Fire-and-forget safe: never throws, debounced per user (10 min, in-memory).
 * Deliberately does NOT resurrect watches the user stopped (expiresAt null).
 * `register` is injectable for tests only.
 */
export async function ensureFreshGmailWatch(
  userId: string,
  register: typeof registerGmailWatch = registerGmailWatch,
): Promise<void> {
  try {
    if (!process.env.GMAIL_PUBSUB_TOPIC) return;
    const last = watchEnsureLastRun.get(userId);
    if (last && Date.now() - last < WATCH_ENSURE_DEBOUNCE_MS) return;
    watchEnsureLastRun.set(userId, Date.now());

    const token = await prisma.userToken.findFirst({
      where: { userId, provider: "google" },
      select: { gmailWatchExpiresAt: true },
    });
    const expiresAt = (token as { gmailWatchExpiresAt?: Date | null } | null)?.gmailWatchExpiresAt;
    if (!expiresAt) return;
    if (expiresAt.getTime() > Date.now() + WATCH_RENEW_MARGIN_MS) return;

    const result = await register(userId);
    if ("error" in result) {
      captureError(new Error(`Gmail watch self-heal failed: ${result.error}`), {
        tags: { scope: "gmail-watch.ensure" },
        extra: { userId },
      });
    } else {
      console.log(`[GMAIL-WATCH] Self-healed expiring watch for ${userId}`);
    }
  } catch (err) {
    captureError(err, { tags: { scope: "gmail-watch.ensure" }, extra: { userId } });
  }
}

// Tool definitions for function calling
export const GMAIL_TOOLS: {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}[] = [
  {
    type: "function" as const,
    function: {
      name: "list_emails",
      description: "List recent emails from the user's Gmail inbox",
      parameters: {
        type: "object",
        properties: {
          max_results: {
            type: "number",
            description: "Number of emails to fetch (default 10, max 20)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_email",
      description: "Read the full content of a specific email by its ID",
      parameters: {
        type: "object",
        properties: {
          email_id: {
            type: "string",
            description: "The Gmail message ID to read",
          },
        },
        required: ["email_id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "classify_emails",
      description:
        "Classify and prioritize inbox emails by urgency (high/medium/low) and category (billing, meeting, engineering, conversation, automated, other). Returns sorted list with high-priority first.",
      parameters: {
        type: "object",
        properties: {
          max_results: {
            type: "number",
            description: "Number of emails to classify (default 10)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "send_email",
      description: "Send an email on behalf of the user",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address" },
          subject: { type: "string", description: "Email subject line" },
          body: { type: "string", description: "Email body text" },
        },
        required: ["to", "subject", "body"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "mark_read",
      description: "Mark an email as read in Gmail and local DB",
      parameters: {
        type: "object",
        properties: {
          email_id: {
            type: "string",
            description: "The Gmail message ID to mark as read",
          },
        },
        required: ["email_id"],
      },
    },
  },
];
