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
 * a user's request.
 *
 * Retried, in memory only (revokeGoogleGrantsInBackground): a grant Google did
 * not revoke (an error or no answer), whose own address could not be read, or
 * that a failed database read never reached is tried again after each of
 * REVOKE_RETRY_DELAYS_MS, then reported once. Another account's address that
 * could not be read is reported, not retried. Every retry checks the holders
 * again and leaves no row out, so a grant linked meanwhile for the same
 * address is left alone; the rows being removed are already gone by then. Not
 * durable on purpose: a queue in the database would keep the token there after
 * the deletion, and the privacy policy says OAuth tokens leave the database in
 * the same operation. A process stopping before the retries are done loses
 * them (reportPendingGoogleRevokes reports them at shutdown); the grant then
 * stays at Google, and its token in the backups until they expire.
 *
 * Microsoft grants are not revoked: Graph offers no per-app refresh-token
 * revocation, only revokeSignInSessions, which signs the user out everywhere.
 */

import { google } from "googleapis";
import { decryptOptional } from "../crypto-tokens.js";
import { prisma } from "../db.js";
import { countGoogleDriveGrantsFor, googleDriveGrantsOf } from "../drive/linked-drive-accounts.js";
import { getOAuth2Client } from "../mail/gmail.js";
import { captureError } from "../sentry.js";
import { newWork } from "../work-context.js";

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
/**
 * The waits before each retry of an unsettled grant: one minute (a blip), ten
 * minutes, then an hour (a short Google outage), about 71 minutes in all.
 */
export const REVOKE_RETRY_DELAYS_MS: readonly number[] = [60_000, 10 * 60_000, 60 * 60_000];

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
 * Does any grant row outside `exclude` (the rows being removed) hold this
 * address? "unknown" when that cannot be settled. The linked tables are matched
 * case-insensitively: older rows were not always lowercased, and a wider match
 * only ever means not revoking. The rows are counted again after the slow
 * lookups, so a grant linked for this address meanwhile is still seen.
 */
async function heldElsewhere(
  email: string,
  exclude: readonly HeldGoogleGrant[],
): Promise<"yes" | "no" | "unknown"> {
  if ((await countHolders(email, exclude)) > 0) return "yes";

  // Primary grants whose address was never read: read them now, bounded.
  const removedPrimary = exclude.filter((g) => g.source === "primary").map((g) => g.rowId);
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
  return (await countHolders(email, exclude)) > 0 ? "yes" : "no";
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

interface DecidedGrant {
  grant: HeldGoogleGrant;
  outcome: RevokeOutcome;
  /** A later pass may settle it: Google did not revoke it, or its own address was not read. */
  retry: boolean;
}

/** One pass over some grants: what it decided, and what a thrown error left undecided. */
interface RevokePass {
  decided: DecidedGrant[];
  undecided: HeldGoogleGrant[];
  error?: unknown;
}

/**
 * Revoke each grant at Google unless a grant row outside `exclude` holds the
 * same Google account. Never throws: an error ends the pass, and the grants it
 * had not decided yet come back as undecided.
 *
 * Retried are only a revoke Google did not do and a grant whose own address
 * could not be read. Another account's address that could not be read is not:
 * such a row usually stays unreadable (a key change, Gmail off for a Workspace
 * user), and retrying would only hold the tokens and repeat the lookups.
 */
async function revokePass(
  grants: readonly HeldGoogleGrant[],
  exclude: readonly HeldGoogleGrant[],
): Promise<RevokePass> {
  const decided: DecidedGrant[] = [];
  const decide = (grant: HeldGoogleGrant, outcome: RevokeOutcome, retry = false) =>
    decided.push({ grant, outcome, retry });
  const byAddress = new Map<string, HeldGoogleGrant[]>();
  try {
    for (const grant of grants) {
      let email = grant.email;
      if (!email) {
        const lookup = await addressOfTokens(grant.refreshToken, grant.accessToken);
        if ("dead" in lookup) {
          decide(grant, "already-invalid");
          continue;
        }
        if ("unknown" in lookup) {
          decide(grant, "unknown-account", true);
          continue;
        }
        email = lookup.email;
      }
      byAddress.set(email, [...(byAddress.get(email) ?? []), grant]);
    }
    for (const [email, held] of byAddress) {
      const elsewhere = await heldElsewhere(email, exclude);
      if (elsewhere !== "no") {
        const outcome = elsewhere === "yes" ? "shared" : "unknown-account";
        for (const grant of held) decide(grant, outcome);
        continue;
      }
      // Each token, in case Google revokes per token rather than per grant; a
      // token the first revoke already killed answers invalid_token.
      for (const grant of held) {
        const token = grant.refreshToken ?? grant.accessToken;
        const outcome = token ? await revokeToken(token) : "already-invalid";
        decide(grant, outcome, outcome === "failed");
      }
    }
    return { decided, undecided: [] };
  } catch (error) {
    const seen = new Set(decided.map((d) => d.grant));
    return { decided, undecided: grants.filter((g) => !seen.has(g)), error };
  }
}

function resultsOf(pass: RevokePass): RevokeResult[] {
  return pass.decided.map(({ grant, outcome }) => ({ source: grant.source, outcome }));
}

function reportPassError(userId: string, error: unknown): void {
  console.error(`[GOOGLE-REVOKE] Revoking ${userId}'s grants failed:`, error);
  captureError(error, { tags: { scope: "google.revoke", userId } });
}

/**
 * Revoke the given grants (already removed from Klorn) at Google, once, unless
 * another grant row holds the same Google account. Never throws.
 */
export async function revokeGoogleGrants(
  userId: string,
  grants: readonly HeldGoogleGrant[],
): Promise<RevokeResult[]> {
  const pass = await revokePass(grants, grants);
  if (pass.error !== undefined) {
    reportPassError(userId, pass.error);
    return resultsOf(pass);
  }
  const results = resultsOf(pass);
  reportUnrevoked(userId, results);
  return results;
}

/** Retries waiting on their timer, with the user each is for (reported at shutdown). */
const pendingRetries = new Map<ReturnType<typeof setTimeout>, string>();

/**
 * Revoke the given grants (already removed from Klorn) at Google without the
 * caller waiting, retrying the unsettled ones after each of `delays`; what is
 * still unrevoked after the last is reported once. Each retry is new work
 * (work-context.ts), not part of the request that started it. Never throws.
 */
export function revokeGoogleGrantsInBackground(
  userId: string,
  grants: readonly HeldGoogleGrant[],
  delays: readonly number[] = REVOKE_RETRY_DELAYS_MS,
): void {
  if (grants.length === 0) return;
  runAttempt(userId, grants, delays, 0);
}

function runAttempt(
  userId: string,
  grants: readonly HeldGoogleGrant[],
  delays: readonly number[],
  attempt: number,
): void {
  attemptRevoke(userId, grants, delays, attempt).catch((err: unknown) => {
    console.error(`[GOOGLE-REVOKE] The revoke of ${userId}'s grants stopped:`, err);
  });
}

/** Only what a retry needs: an access token is dead within the hour, so a refresh token replaces it. */
function retainedForRetry(grant: HeldGoogleGrant): HeldGoogleGrant {
  return grant.refreshToken ? { ...grant, accessToken: null } : grant;
}

async function attemptRevoke(
  userId: string,
  grants: readonly HeldGoogleGrant[],
  delays: readonly number[],
  attempt: number,
): Promise<void> {
  // The first pass leaves out the rows being removed, as the single pass does.
  // A retry leaves out nothing: every caller deleted those rows before the
  // revoke started, so one still there means its removal did not happen.
  const pass = await revokePass(grants, attempt === 0 ? grants : []);
  const unsettled = [...pass.decided.filter((d) => d.retry).map((d) => d.grant), ...pass.undecided];
  const delay = delays[attempt];
  if (unsettled.length === 0 || delay === undefined) {
    if (pass.error !== undefined) reportPassError(userId, pass.error);
    reportUnrevoked(userId, resultsOf(pass));
    return;
  }
  const code = (pass.error as { code?: unknown } | undefined)?.code;
  console.warn(
    `[GOOGLE-REVOKE] ${unsettled.length} of ${userId}'s grants not revoked yet` +
      (pass.error !== undefined
        ? ` (database error${typeof code === "string" ? ` ${code}` : ""})`
        : "") +
      `; retry ${attempt + 1} of ${delays.length} in ${Math.round(delay / 1000)} s.`,
  );
  const retained = unsettled.map(retainedForRetry);
  const timer = setTimeout(
    newWork(() => {
      pendingRetries.delete(timer);
      runAttempt(userId, retained, delays, attempt + 1);
    }),
    delay,
  );
  timer.unref?.();
  pendingRetries.set(timer, userId);
}

/** How many revoke retries are waiting on their timer. */
export function pendingGoogleRevokeRetries(): number {
  return pendingRetries.size;
}

/**
 * At shutdown: the retries still waiting die with the process, so report them
 * once (a count and the user ids: no token, no address). Answers the count.
 */
export function reportPendingGoogleRevokes(): number {
  const pending = pendingRetries.size;
  if (pending === 0) return 0;
  const userIds = [...new Set(pendingRetries.values())];
  console.warn(
    `[GOOGLE-REVOKE] ${pending} revoke retries were still waiting at shutdown; ` +
      `those grants stay at Google (users: ${userIds.join(", ")}).`,
  );
  captureError(new Error("google grant revokes were pending at shutdown"), {
    tags: { scope: "google.revoke.shutdown" },
    extra: { pending, userIds },
  });
  return pending;
}

/**
 * What a revoke left in place is reported: a failure Google gave, or an
 * account Klorn could not settle (fail closed: not revoked). The second, if it
 * repeats for every user, means an unreadable grant row blocks every revoke.
 */
function reportUnrevoked(userId: string, results: readonly RevokeResult[]): void {
  const unrevoked = results.filter(
    (r) => r.outcome === "failed" || r.outcome === "unknown-account",
  );
  if (unrevoked.length === 0) return;
  const summary = unrevoked.map((r) => `${r.source}:${r.outcome}`).join(", ");
  console.warn(`[GOOGLE-REVOKE] Not every grant of ${userId} was revoked (${summary}).`);
  const failed = unrevoked.some((r) => r.outcome === "failed");
  captureError(new Error(failed ? "google grant revoke failed" : "google grant revoke unsettled"), {
    tags: { scope: "google.revoke", userId },
    extra: { summary },
  });
}

/**
 * Collect the selected grants, run `remove` (the delete that ends them in
 * Klorn), and start revoking them at Google, with retries, when `removed` says
 * the delete went through. A failed collect or revoke is logged and never fails `remove`.
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
  if (removed(result)) revokeGoogleGrantsInBackground(userId, grants);
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
