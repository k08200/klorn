/**
 * Connected accounts and their health (productization plan §1, P6) — the pure
 * half, shared by Today's accounts strip and the sidebar's Accounts group.
 * One unified list, no switcher (FD-2). Pinned by
 * packages/api/src/__tests__/web-today-model.test.ts.
 */

import type { InboxOption } from "@klorn/contract";
import { type AccountOption, accountOptions } from "../app/email/_v2/model";

/**
 * What the wire can honestly say about an account. `syncing` is the primary
 * account's sign-in sync only: linked accounts report no sync-in-progress
 * state, so they are never shown as syncing.
 */
export type AccountHealth = "synced" | "syncing" | "reconnect";

export interface ConnectedAccount extends AccountOption {
  health: AccountHealth;
}

interface ConnectionState {
  /** Whether the primary Google grant exists; null while unknown. */
  googleConnected: boolean | null;
  /** The primary account's sign-in sync is running. */
  primarySyncing: boolean;
}

/**
 * The connected sources, primary first. GET /api/email/inboxes always returns
 * a primary row, so a primary without a Google grant is dropped: it is not a
 * source, and listing it would claim an account that was never connected.
 */
export function connectedAccounts(
  inboxes: readonly InboxOption[],
  state: ConnectionState,
): ConnectedAccount[] {
  return accountOptions(inboxes)
    .filter((account) => account.linkedId !== null || state.googleConnected !== false)
    .map((account) => ({
      ...account,
      health: account.needsReconnect
        ? "reconnect"
        : account.linkedId === null && state.primarySyncing
          ? "syncing"
          : "synced",
    }));
}
