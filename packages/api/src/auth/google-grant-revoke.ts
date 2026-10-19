/**
 * Revoke Klorn's Google grants at Google when they stop being used: a data
 * wipe, an account deletion, or a disconnect of a Google account.
 *
 * Before this, those paths deleted only Klorn's copy of the tokens. The grant
 * stayed on the user's Google account (Klorn still listed under "third-party
 * access"), an access token already handed to running work stayed valid for up
 * to an hour, and the encrypted refresh token stayed valid in the nightly
 * backups for their 14 days.
 *
 * Google may revoke the whole grant (every token for that Google account and
 * this app), not only the token sent, and two Klorn accounts can hold grants
 * for the same Google account: a mailbox linked by two users, or one account's
 * sign-in address linked by another. So a grant is revoked only when no other
 * grant row (another user's, or this user's own row that stays) holds the
 * same Google address. Unsure means not revoked: an address that cannot be
 * read, or more unknown addresses than MAX_UNKNOWN_ADDRESSES to check.
 *
 * Best effort and never throws: the deletion or disconnect has already been
 * committed, and a failed revoke is logged and reported, not raised. The
 * disconnect routes and the deletions do not wait for it (removeAndRevokeGoogle
 * and the callers start it after the commit), so Google's latency never holds
 * a user's request. Not durable: a process stopping mid-revoke loses it, and a
 * grant linked again for the same address while the revoke runs can be cut.
 * Microsoft grants are not revoked: Graph offers no per-app refresh-token
 * revocation, only revokeSignInSessions, which signs the user out everywhere.
 */

import { google } from "googleapis";
import { decryptOptional } from "../crypto-tokens.js";
import { prisma } from "../db.js";
import { countGoogleDriveGrantsFor, googleDriveGrantsOf } from "../drive/linked-drive-accounts.js";
import { getOAuth2Client } from "../mail/gmail.js";
import { captureError } from "../sentry.js";

export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_CALL_TIMEOUT_MS = 10_000;
/** One address lookup, its token refresh included (the refresh has no timeout of its own). */
const ADDRESS_LOOKUP_DEADLINE_MS = 15_000;
/** Other users' primary grants of unknown address one revoke may look up. */
export const MAX_UNKNOWN_ADDRESSES = 25;
/**
 * UserToken.googleEmail of a grant Google already refuses (invalid_grant): it
 * has no address to read and cannot be harmed by a revoke, so the shared-grant
 * check and the backfill stop looking it up. A reconnect clears it (null).
 */
export const DEAD_GRANT_ADDRESS = "";

export type GrantSource = "primary" | "inbox" | "calendar" | "drive";

/** One grant about to be removed, with its tokens decrypted. */
export interface HeldGoogleGrant {
  source: GrantSource;
  rowId: string;
  /** Lowercased Google address, or null when the row does not store it. */
  email: string | null;
  refreshToken: string | null;
  accessToken: string | null;
}

export type RevokeOutcome = "revoked" | "already-invalid" | "shared" | "unknown-account" | "failed";

export interface RevokeResult {
  source: GrantSource;
  outcome: RevokeOutcome;
}

/** Which grants to collect; omitted, all of the user's Google grants. */
export interface GrantSelection {
  primary?: boolean;
  inboxIds?: readonly string[];
  calendarIds?: readonly string[];
  driveIds?: readonly string[];
}

type AddressLookup = { email: string } | { dead: true } | { unknown: true };

function normalise(email: string): string {
  return email.trim().toLowerCase();
}

function tryDecrypt(value: string | null | undefined): string | null {
  try {
    return decryptOptional(value);
  } catch {
    return null;
  }
}

/** True when a stored cipher is present but cannot be decrypted (a key change, a bad row). */
function undecryptable(...values: Array<string | null | undefined>): boolean {
  return values.some((value) => value != null && value !== "" && tryDecrypt(value) === null);
}

function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Read this user's Google grants, before their rows are deleted. */
export async function collectGoogleGrants(
  userId: string,
  selection?: GrantSelection,
): Promise<HeldGoogleGrant[]> {
  const all = selection === undefined;
  const grants: HeldGoogleGrant[] = [];
  if (all || selection?.primary) {
    const rows = await prisma.userToken.findMany({
      where: { userId, provider: "google" },
      select: { id: true, googleEmail: true, accessToken: true, refreshToken: true },
    });
    for (const row of rows) {
      grants.push({
        source: "primary",
        rowId: row.id,
        email: row.googleEmail ? normalise(row.googleEmail) : null,
        accessToken: tryDecrypt(row.accessToken),
        refreshToken: tryDecrypt(row.refreshToken),
      });
    }
  }
  if (all || selection?.inboxIds?.length) {
    const rows = await prisma.linkedInboxAccount.findMany({
      where: {
        userId,
        provider: "GOOGLE",
        ...(all ? {} : { id: { in: [...(selection?.inboxIds ?? [])] } }),
      },
      select: { id: true, email: true, accessToken: true, refreshToken: true },
    });
    for (const row of rows) {
      grants.push({
        source: "inbox",
        rowId: row.id,
        email: normalise(row.email),
        accessToken: tryDecrypt(row.accessToken),
        refreshToken: tryDecrypt(row.refreshToken),
      });
    }
  }
  if (all || selection?.calendarIds?.length) {
    const rows = await prisma.linkedCalendarAccount.findMany({
      where: {
        userId,
        provider: "GOOGLE",
        ...(all ? {} : { id: { in: [...(selection?.calendarIds ?? [])] } }),
      },
      select: { id: true, email: true, accessToken: true, refreshToken: true },
    });
    for (const row of rows) {
      grants.push({
        source: "calendar",
        rowId: row.id,
        email: normalise(row.email),
        accessToken: tryDecrypt(row.accessToken),
        refreshToken: tryDecrypt(row.refreshToken),
      });
    }
  }
  if (all || selection?.driveIds?.length) {
    const rows = await googleDriveGrantsOf(userId, all ? undefined : selection?.driveIds);
    for (const row of rows) {
      grants.push({
        source: "drive",
        rowId: row.id,
        email: normalise(row.email),
        accessToken: tryDecrypt(row.accessToken),
        refreshToken: tryDecrypt(row.refreshToken),
      });
    }
  }
  return grants;
}

/** The Google account a token belongs to, read from its Gmail profile. */
function addressOfTokens(
  refreshToken: string | null,
  accessToken: string | null,
): Promise<AddressLookup> {
  if (!refreshToken && !accessToken) return Promise.resolve({ dead: true });
  return withDeadline(readProfileAddress(refreshToken, accessToken), ADDRESS_LOOKUP_DEADLINE_MS, {
    unknown: true,
  });
}

async function readProfileAddress(
  refreshToken: string | null,
  accessToken: string | null,
): Promise<AddressLookup> {
  try {
    const auth = getOAuth2Client();
    auth.setCredentials({
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      ...(accessToken ? { access_token: accessToken } : {}),
    });
    const gmail = google.gmail({ version: "v1", auth });
    const res = await gmail.users.getProfile({ userId: "me" }, { timeout: GOOGLE_CALL_TIMEOUT_MS });
    const email = res.data.emailAddress;
    return email ? { email: normalise(email) } : { unknown: true };
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    const message = err instanceof Error ? err.message : String(err);
    // A grant Google already refuses cannot be harmed by a revoke. A Workspace
    // re-authentication demand (invalid_rapt) is not that: the user can still
    // recover the grant, so its address stays unknown.
    if (/invalid_rapt|rapt_required/.test(message)) return { unknown: true };
    if (status === 401 || /invalid_grant|unauthorized_client/.test(message)) return { dead: true };
    return { unknown: true };
  }
}

/**
 * Record what a lookup of a primary grant found: its address, or the dead
 * marker, and when it was checked (the check order). Only onto the same tokens
 * it was read with: a reconnect in between (perhaps of another Google account)
 * cleared the address and must not get this one.
 */
async function rememberLookup(
  tokenId: string,
  accessCipher: string,
  lookup: AddressLookup,
): Promise<void> {
  const address =
    "email" in lookup ? lookup.email : "dead" in lookup ? DEAD_GRANT_ADDRESS : undefined;
  await prisma.userToken
    .updateMany({
      where: { id: tokenId, googleEmail: null, accessToken: accessCipher },
      data: {
        googleEmailCheckedAt: new Date(),
        ...(address !== undefined ? { googleEmail: address } : {}),
      },
    })
    .catch(() => {});
}

/** Primary grants of unknown address, least recently checked first. */
function unknownPrimaryGrants(exceptIds: readonly string[], take: number) {
  return prisma.userToken.findMany({
    where: { provider: "google", googleEmail: null, id: { notIn: [...exceptIds] } },
    select: { id: true, accessToken: true, refreshToken: true },
    orderBy: [{ googleEmailCheckedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    take,
  });
}

/** Grant rows other than those being removed that hold this address. */
async function countHolders(email: string, removed: readonly HeldGoogleGrant[]): Promise<number> {
  const idsOf = (source: GrantSource) =>
    removed.filter((g) => g.source === source).map((g) => g.rowId);
  const sameAddress = { equals: email, mode: "insensitive" as const };
  const counts = await Promise.all([
    prisma.linkedInboxAccount.count({
      where: { provider: "GOOGLE", email: sameAddress, id: { notIn: idsOf("inbox") } },
    }),
    prisma.linkedCalendarAccount.count({
      where: { provider: "GOOGLE", email: sameAddress, id: { notIn: idsOf("calendar") } },
    }),
    countGoogleDriveGrantsFor(email, idsOf("drive")),
    prisma.userToken.count({
      where: { provider: "google", googleEmail: sameAddress, id: { notIn: idsOf("primary") } },
    }),
  ]);
  return counts.reduce((sum, n) => sum + n, 0);
}

/**
 * Does any grant row other than those being removed hold this address?
 * "unknown" when that cannot be settled. The linked tables are matched
 * case-insensitively: older rows were not always lowercased, and a wider match
 * only ever means not revoking. The rows are counted again after the slow
 * lookups, so a grant linked for this address meanwhile is still seen.
 */
async function heldElsewhere(
  email: string,
  removed: readonly HeldGoogleGrant[],
): Promise<"yes" | "no" | "unknown"> {
  if ((await countHolders(email, removed)) > 0) return "yes";

  // Primary grants whose address was never read: read them now, bounded.
  const removedPrimary = removed.filter((g) => g.source === "primary").map((g) => g.rowId);
  const unknown = await unknownPrimaryGrants(removedPrimary, MAX_UNKNOWN_ADDRESSES + 1);
  if (unknown.length > MAX_UNKNOWN_ADDRESSES) return "unknown";
  let unsure = false;
  for (const row of unknown) {
    // A cipher that will not decrypt is a live grant we cannot read, not a dead one.
    if (undecryptable(row.accessToken, row.refreshToken)) {
      unsure = true;
      continue;
    }
    const lookup = await addressOfTokens(tryDecrypt(row.refreshToken), tryDecrypt(row.accessToken));
    await rememberLookup(row.id, row.accessToken, lookup);
    if ("email" in lookup && lookup.email === email) return "yes";
    if ("unknown" in lookup) unsure = true;
  }
  if (unsure) return "unknown";
  return (await countHolders(email, removed)) > 0 ? "yes" : "no";
}

/** POST one token to Google's revoke endpoint. */
async function revokeToken(token: string): Promise<"revoked" | "already-invalid" | "failed"> {
  try {
    const res = await fetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(GOOGLE_CALL_TIMEOUT_MS),
    });
    if (res.ok) return "revoked";
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    return res.status === 400 && body.error === "invalid_token" ? "already-invalid" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * Revoke the given grants (already removed, or about to be, from Klorn) at
 * Google, unless another grant row holds the same Google account. Never throws.
 */
export async function revokeGoogleGrants(
  userId: string,
  grants: readonly HeldGoogleGrant[],
): Promise<RevokeResult[]> {
  const results: RevokeResult[] = [];
  const byAddress = new Map<string, HeldGoogleGrant[]>();
  try {
    for (const grant of grants) {
      let email = grant.email;
      if (!email) {
        const lookup = await addressOfTokens(grant.refreshToken, grant.accessToken);
        if ("dead" in lookup) {
          results.push({ source: grant.source, outcome: "already-invalid" });
          continue;
        }
        if ("unknown" in lookup) {
          results.push({ source: grant.source, outcome: "unknown-account" });
          continue;
        }
        email = lookup.email;
      }
      byAddress.set(email, [...(byAddress.get(email) ?? []), grant]);
    }
    for (const [email, held] of byAddress) {
      const elsewhere = await heldElsewhere(email, grants);
      if (elsewhere !== "no") {
        const outcome = elsewhere === "yes" ? "shared" : "unknown-account";
        for (const grant of held) results.push({ source: grant.source, outcome });
        continue;
      }
      // Each token, in case Google revokes per token rather than per grant; a
      // token the first revoke already killed answers invalid_token.
      for (const grant of held) {
        const token = grant.refreshToken ?? grant.accessToken;
        results.push({
          source: grant.source,
          outcome: token ? await revokeToken(token) : "already-invalid",
        });
      }
    }
    reportUnrevoked(userId, results);
  } catch (err) {
    console.error(`[GOOGLE-REVOKE] Revoking ${userId}'s grants failed:`, err);
    captureError(err, { tags: { scope: "google.revoke", userId } });
  }
  return results;
}

function reportUnrevoked(userId: string, results: readonly RevokeResult[]): void {
  const failed = results.filter((r) => r.outcome === "failed" || r.outcome === "unknown-account");
  if (failed.length > 0) {
    const summary = failed.map((r) => `${r.source}:${r.outcome}`).join(", ");
    console.warn(`[GOOGLE-REVOKE] Not every grant of ${userId} was revoked (${summary}).`);
    if (failed.some((r) => r.outcome === "failed")) {
      captureError(new Error("google grant revoke failed"), {
        tags: { scope: "google.revoke", userId },
        extra: { summary },
      });
    }
  }
}

/**
 * Collect the selected grants, run `remove` (the delete that ends them in
 * Klorn), and start revoking them at Google when `removed` says the delete
 * went through. A failed collect or revoke is logged and never fails `remove`.
 */
export async function removeAndRevokeGoogle<T>(
  userId: string,
  selection: GrantSelection | undefined,
  remove: () => Promise<T>,
  removed: (result: T) => boolean,
): Promise<T> {
  const grants = await collectGoogleGrants(userId, selection).catch((err: unknown) => {
    console.error(`[GOOGLE-REVOKE] Could not read ${userId}'s grants before removing them:`, err);
    captureError(err, { tags: { scope: "google.revoke.collect", userId } });
    return [] as HeldGoogleGrant[];
  });
  const result = await remove();
  // Not awaited: Google's latency must not hold the user's request.
  if (grants.length > 0 && removed(result)) void revokeGoogleGrants(userId, grants);
  return result;
}

/**
 * Store the Google address of a freshly connected primary grant (best effort),
 * onto that grant only: `accessCipher` is the access token as the connect
 * stored it, so a later reconnect or refresh is never given this address.
 */
export async function rememberPrimaryGoogleAddress(
  userId: string,
  tokens: { refresh_token?: string | null; access_token?: string | null },
  accessCipher: string,
): Promise<void> {
  const lookup = await addressOfTokens(tokens.refresh_token ?? null, tokens.access_token ?? null);
  if (!("email" in lookup)) return;
  await prisma.userToken
    .updateMany({
      where: { userId, provider: "google", googleEmail: null, accessToken: accessCipher },
      data: { googleEmail: lookup.email },
    })
    .catch((err: unknown) => {
      console.warn(`[GOOGLE-REVOKE] Could not store ${userId}'s Google address:`, err);
    });
}

/**
 * Fill in the addresses of primary grants that have none (connected before the
 * column existed, or whose read at connect failed). Bounded per run.
 */
export async function backfillPrimaryGoogleAddresses(limit = 50): Promise<{ filled: number }> {
  const rows = await unknownPrimaryGrants([], limit);
  let filled = 0;
  for (const row of rows) {
    if (undecryptable(row.accessToken, row.refreshToken)) {
      // Still checked: it goes to the back of the order instead of the front.
      await rememberLookup(row.id, row.accessToken, { unknown: true });
      continue;
    }
    const lookup = await addressOfTokens(tryDecrypt(row.refreshToken), tryDecrypt(row.accessToken));
    await rememberLookup(row.id, row.accessToken, lookup);
    if ("email" in lookup) filled++;
  }
  return { filled };
}
