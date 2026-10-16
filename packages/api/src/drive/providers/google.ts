/**
 * The Google Drive connector (step D5 of docs/providers/unified-platform-plan.md),
 * served by the dispatcher (providers/dispatch.ts) only while DRIVE_ENABLED and
 * GOOGLE_DRIVE_ENABLED are both on.
 *
 * `connect` answers a session only for an account that is the user's own, of
 * this provider, and not flagged for reconnect (the seam's first rule:
 * providers/types.ts); otherwise null. The account is loaded by (id, userId,
 * provider) every time: the DriveFile foreign key proves an account exists, not
 * who owns it.
 *
 * D5b ships the grant only. The session's reads (metadata of picked files, the
 * listing, the search, the bytes for a summary) arrive with D5c and D5d; until
 * then each refuses with an error and calls no Google API. No row of this
 * provider can exist before D5c writes one, so nothing reaches them.
 */

import { loadDriveAccountCredentials } from "../linked-drive-accounts.js";
import { buildLinkedDriveClient, type LinkedDriveClient } from "./google-auth.js";
import type { DriveProviderActions, DriveProviderSession, DriveSourceRef } from "./types.js";

function notYet(method: string): Promise<never> {
  return Promise.reject(new Error(`Google Drive ${method} is not available yet (D5c).`));
}

/** The session of one linked account. Holds its client for D5c; reads nothing yet. */
function googleDriveSession(_linked: LinkedDriveClient): DriveProviderSession {
  return {
    provider: "GOOGLE",
    list: () => notYet("list"),
    search: () => notYet("search"),
    getMetadata: () => notYet("getMetadata"),
    fetchForSummary: () => notYet("fetchForSummary"),
  };
}

async function connectGoogleDrive(source: DriveSourceRef): Promise<DriveProviderSession | null> {
  const account = await loadDriveAccountCredentials(source.userId, "GOOGLE", source.sourceKey);
  // A flagged account stays flagged until a re-link: no retry of a dead grant.
  if (!account || account.needsReconnect) return null;
  const linked = buildLinkedDriveClient(source.userId, account);
  return linked ? googleDriveSession(linked) : null;
}

export const googleDriveActions: DriveProviderActions = {
  provider: "GOOGLE",
  connect: connectGoogleDrive,
};
