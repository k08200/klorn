/**
 * The server's two steps of the Google Picker (step D5c of
 * docs/providers/unified-platform-plan.md, D5 "Picker" and "Metadata").
 *
 *   1. `openGooglePickerSession`: what the browser's Picker needs for one of
 *      the user's own Google accounts: a drive.file access token, minted on
 *      click through the account's OAuth client (buildLinkedDriveClient), and
 *      the two public values of config.ts's `googlePickerConfig`. The token is
 *      the ONE secret Klorn sends a browser, by design: the Picker runs there.
 *      It is never stored or logged here.
 *   2. `indexPickedGoogleFiles`: the ids the user picked, and only the ids.
 *      Every field of a row is what Google's files.get answers for that id on
 *      that account's grant (a 404 is "not granted"), written through the one
 *      writer (drive/drive-rows.ts) as a GOOGLE row of that account, then its
 *      summary queued (summary-triggers.ts; D5d's connector reads the bytes).
 *      Folders, shortcuts and trashed files are refused, and an account holds
 *      at most GOOGLE_DRIVE_ROWS_PER_ACCOUNT rows. D5d's hourly refresh keeps
 *      the rows up to date (google-drive-refresh.ts).
 *
 * The account is loaded by (id, userId, provider) first, every time: the
 * DriveFile foreign key proves an account exists, not who owns it.
 *
 * Logging: a googleapis error carries its request's config, Authorization header
 * included. Nothing here logs or reports one; only its HTTP status, in a new Error.
 *
 * The cap is read once per request, not under a lock: requests running at once
 * for the same account each see the same count, so each can add up to
 * GOOGLE_PICK_MAX_IDS past it (the route's rate limit, 10 a minute, bounds the
 * worst case). The next request sees the true count and adds nothing new.
 *
 * Only a drive.file grant's token goes to a browser: a grant that also carries
 * another scope (a Gmail or Calendar one; the link stores it and reports it,
 * google-auth.ts) or lacks drive.file gets no Picker session. Checked twice:
 * on the stored grant before any token is minted, and on the minted token's own
 * scopes (Google's tokeninfo) before it is returned. A token whose scopes could
 * not be read is not returned either.
 */

import type {
  GoogleDrivePickerSessionResponse,
  GoogleDrivePickRefusal,
  GoogleDrivePickRefusalCode,
} from "@klorn/contract";
import { googlePickerConfig } from "../config.js";
import { captureError } from "../sentry.js";
import { type ConnectedAccountRows, connectedAccountRows } from "./drive-read.js";
import { connectedDriveSource, type DriveFileInput, upsertDriveFileRow } from "./drive-rows.js";
import { loadDriveAccountCredentials } from "./linked-drive-accounts.js";
import { googleDriveSession } from "./providers/google.js";
import {
  buildLinkedDriveClient,
  handleDriveGrantFailure,
  hasDriveFileScope,
  type LinkedDriveClient,
  unexpectedGrantScopes,
} from "./providers/google-auth.js";
import {
  GOOGLE_FOLDER_MIME,
  GOOGLE_SHORTCUT_MIME,
  googleErrorStatus,
  isGoogleDriveId,
  isGoogleFileForbidden,
} from "./providers/google-files.js";
import type { DriveProviderSession, ProviderDriveFile } from "./providers/types.js";
import { enqueueSummaryOnWrite } from "./summary-triggers.js";

/** The most ids one pick may send (the Picker's `setMaxItems`). */
export const GOOGLE_PICK_MAX_IDS = 50;
/** The most rows Klorn indexes from one Google account (plan, D5 "Metadata"). */
export const GOOGLE_DRIVE_ROWS_PER_ACCOUNT = 500;
/** files.get calls in flight for one pick. */
const METADATA_IN_FLIGHT = 4;
/**
 * A token closer than this to its expiry is refreshed before it goes to the
 * Picker, so a person browsing for a while is not cut off mid-pick.
 */
const PICKER_TOKEN_MIN_LIFE_MS = 15 * 60 * 1000;

type AccountFailure = "not-found" | "needs-reconnect";
type GoogleFailure = "needs-reconnect" | "unavailable";

export type PickerSessionResult =
  | { readonly ok: true; readonly session: GoogleDrivePickerSessionResponse }
  | {
      readonly ok: false;
      readonly reason: AccountFailure | GoogleFailure | "not-configured" | "grant-too-broad";
    };

export type PickedFilesResult =
  | { readonly ok: true; readonly added: number; readonly refused: GoogleDrivePickRefusal[] }
  | { readonly ok: false; readonly reason: AccountFailure | GoogleFailure };

type AccountClient =
  | { readonly ok: true; readonly linked: LinkedDriveClient; readonly grantedScopes: string }
  | { readonly ok: false; readonly reason: AccountFailure };

/** The OAuth client of the user's own GOOGLE account, or why there is none. */
async function ownAccountClient(userId: string, accountId: string): Promise<AccountClient> {
  const account = await loadDriveAccountCredentials(userId, "GOOGLE", accountId);
  if (account === null) return { ok: false, reason: "not-found" };
  // A flagged account stays flagged until a re-link: its grant is not decrypted.
  if (account.needsReconnect) return { ok: false, reason: "needs-reconnect" };
  // Null when the grant cannot be decrypted; that flags the account itself.
  const linked = buildLinkedDriveClient(userId, account);
  if (linked === null) return { ok: false, reason: "needs-reconnect" };
  return { ok: true, linked, grantedScopes: account.grantedScopes };
}

/** A grant whose token may go to a browser: drive.file, and the identity scopes only. */
function isDriveFileOnlyGrant(grantedScopes: string): boolean {
  return hasDriveFileScope(grantedScopes) && unexpectedGrantScopes(grantedScopes).length === 0;
}

/** A failed Google call: a revoked grant flags the account; anything else is an outage. */
async function settleGoogleFailure(
  userId: string,
  accountId: string,
  step: "picker-token" | "picked-metadata",
  err: unknown,
): Promise<GoogleFailure> {
  if (await handleDriveGrantFailure(userId, accountId, err)) return "needs-reconnect";
  const status = googleErrorStatus(err) ?? "no response";
  console.warn(`[GOOGLE-DRIVE] ${step} failed for drive account ${accountId}: ${status}`);
  // A new Error, never `err`: its request config holds the bearer token.
  captureError(new Error(`Google Drive ${step} failed: ${status}`), {
    tags: { scope: `drive.google.${step}` },
    extra: { userId, accountId },
  });
  return "unavailable";
}

/**
 * The minted token's own scopes, read back from Google: whether it may go to a
 * browser, or "unavailable" when Google could not say. Logs a status only.
 */
async function verifyTokenScopes(
  client: LinkedDriveClient["client"],
  token: string,
  accountId: string,
): Promise<"ok" | "grant-too-broad" | "unavailable"> {
  try {
    const info = await client.getTokenInfo(token);
    const scopes = Array.isArray(info.scopes) ? info.scopes.join(" ") : "";
    return isDriveFileOnlyGrant(scopes) ? "ok" : "grant-too-broad";
  } catch (err) {
    const status = googleErrorStatus(err) ?? "no response";
    console.warn(
      `[GOOGLE-DRIVE] picker tokeninfo failed for drive account ${accountId}: ${status}`,
    );
    // A new Error, never `err`: its request carries the token.
    captureError(new Error(`Google Drive picker tokeninfo failed: ${status}`), {
      tags: { scope: "drive.google.picker-tokeninfo" },
      extra: { accountId },
    });
    return "unavailable";
  }
}

/** Step 1: the Picker's token, key and app id for one of the user's own accounts. */
export async function openGooglePickerSession(
  userId: string,
  accountId: string,
): Promise<PickerSessionResult> {
  // Before the account is touched: no token is minted for a Picker that cannot open.
  const config = googlePickerConfig();
  if (config === null) return { ok: false, reason: "not-configured" };
  const account = await ownAccountClient(userId, accountId);
  if (!account.ok) return account;
  if (!isDriveFileOnlyGrant(account.grantedScopes)) return { ok: false, reason: "grant-too-broad" };
  const { client } = account.linked;
  client.eagerRefreshThresholdMillis = PICKER_TOKEN_MIN_LIFE_MS;
  let token: string | null | undefined;
  try {
    // A refresh it makes is saved encrypted by the client's own listener.
    ({ token } = await client.getAccessToken());
  } catch (err) {
    return { ok: false, reason: await settleGoogleFailure(userId, accountId, "picker-token", err) };
  }
  if (!token) return { ok: false, reason: "unavailable" };
  const verified = await verifyTokenScopes(client, token, accountId);
  if (verified !== "ok") return { ok: false, reason: verified };
  // The record that a token left for a browser: who and which account, never the token.
  console.info(
    `[GOOGLE-DRIVE] picker token issued for drive account ${accountId} (user ${userId})`,
  );
  return { ok: true, session: { accessToken: token, ...config } };
}

type MetadataRead =
  | { readonly kind: "file"; readonly file: ProviderDriveFile }
  | { readonly kind: "refused"; readonly code: GoogleDrivePickRefusalCode }
  | { readonly kind: "failed"; readonly err: unknown };

async function readMetadata(session: DriveProviderSession, id: string): Promise<MetadataRead> {
  try {
    const file = await session.getMetadata(id);
    return file === null ? { kind: "refused", code: "not-accessible" } : { kind: "file", file };
  } catch (err) {
    // A 403 about the file reads as "not shared"; any other fails the pick loudly.
    if (isGoogleFileForbidden(err)) return { kind: "refused", code: "not-accessible" };
    return { kind: "failed", err };
  }
}

type MetadataReads =
  | { readonly ok: true; readonly reads: ReadonlyMap<string, MetadataRead> }
  | { readonly ok: false; readonly err: unknown };

/** Each id's metadata, a few in flight; the first failure stops the reading. */
async function readAllMetadata(
  session: DriveProviderSession,
  ids: readonly string[],
): Promise<MetadataReads> {
  const reads = new Map<string, MetadataRead>();
  for (let start = 0; start < ids.length; start += METADATA_IN_FLIGHT) {
    const batch = ids.slice(start, start + METADATA_IN_FLIGHT);
    const results = await Promise.all(batch.map((id) => readMetadata(session, id)));
    for (const [index, read] of results.entries()) {
      if (read.kind === "failed") return { ok: false, err: read.err };
      reads.set(batch[index] as string, read);
    }
  }
  return { ok: true, reads };
}

/** Why Google's answer for `id` cannot be indexed, or null when it can. */
function refusalOf(id: string, file: ProviderDriveFile): GoogleDrivePickRefusalCode | null {
  if (file.trashed) return "not-accessible";
  if (file.isFolder || file.mimeType === GOOGLE_FOLDER_MIME) return "folder";
  if (file.mimeType === GOOGLE_SHORTCUT_MIME) return "shortcut";
  return file.externalId === id ? null : "invalid";
}

/** The row's fields, all from Google's answer: nothing the browser sent. */
function rowInput(file: ProviderDriveFile): DriveFileInput {
  return {
    name: file.name,
    modifiedAt: file.modifiedAt,
    mimeType: file.mimeType,
    isFolder: false,
    sizeBytes: file.sizeBytes,
    parentExternalId: file.parentExternalId,
    webUrl: file.webUrl,
    etag: file.etag,
    trashed: false,
  };
}

interface IndexContext {
  readonly userId: string;
  readonly accountId: string;
  readonly rows: ConnectedAccountRows;
  readonly reads: ReadonlyMap<string, MetadataRead>;
}

type Verdict = { readonly file: ProviderDriveFile } | { readonly code: GoogleDrivePickRefusalCode };

/** One id's fate: its file to write, or why not. `room` is what is left of the cap. */
function verdictOf(
  id: string,
  read: MetadataRead | undefined,
  isNew: boolean,
  room: number,
): Verdict {
  // Not read: an invalid id, or a new file while the account was full.
  if (read === undefined) return { code: isGoogleDriveId(id) ? "cap" : "invalid" };
  if (read.kind !== "file") return { code: read.kind === "refused" ? read.code : "invalid" };
  const code = refusalOf(id, read.file) ?? (isNew && room <= 0 ? "cap" : null);
  return code === null ? { file: read.file } : { code };
}

/** Write the rows, in pick order, within the cap. Each id: indexed, or why not. */
async function writePicked(
  ctx: IndexContext,
  ids: readonly string[],
): Promise<{ added: number; refused: GoogleDrivePickRefusal[] }> {
  let room = GOOGLE_DRIVE_ROWS_PER_ACCOUNT - ctx.rows.count;
  let added = 0;
  const refused: GoogleDrivePickRefusal[] = [];
  for (const id of ids) {
    const isNew = !ctx.rows.indexed.has(id);
    const verdict = verdictOf(id, ctx.reads.get(id), isNew, room);
    if ("code" in verdict) {
      refused.push({ id, code: verdict.code });
      continue;
    }
    const source = connectedDriveSource("GOOGLE", ctx.accountId, id);
    const written = await upsertDriveFileRow(ctx.userId, source, rowInput(verdict.file));
    if (!written.ok) {
      refused.push({ id, code: "invalid" });
      continue;
    }
    if (isNew) room -= 1;
    added += 1;
    await enqueueSummaryOnWrite(ctx.userId, written.id, verdict.file.etag);
  }
  return { added, refused };
}

/** Step 2: index the picked ids of one of the user's own accounts. */
export async function indexPickedGoogleFiles(
  userId: string,
  accountId: string,
  pickedIds: readonly string[],
): Promise<PickedFilesResult> {
  const account = await ownAccountClient(userId, accountId);
  if (!account.ok) return account;
  const ids = [...new Set(pickedIds)];
  const valid = ids.filter(isGoogleDriveId);
  const rows = await connectedAccountRows(
    userId,
    { provider: "GOOGLE", sourceKey: account.linked.id },
    { externalIds: valid, countUpTo: GOOGLE_DRIVE_ROWS_PER_ACCOUNT },
  );
  // A full account still refreshes the files it holds; a new one is not even read.
  const full = rows.count >= GOOGLE_DRIVE_ROWS_PER_ACCOUNT;
  const toRead = full ? valid.filter((id) => rows.indexed.has(id)) : valid;
  const session = googleDriveSession(account.linked);
  const read = await readAllMetadata(session, toRead);
  if (!read.ok) {
    const reason = await settleGoogleFailure(userId, accountId, "picked-metadata", read.err);
    return { ok: false, reason };
  }
  const ctx = { userId, accountId: account.linked.id, rows, reads: read.reads };
  const written = await writePicked(ctx, ids);
  return { ok: true, ...written };
}
