/**
 * Which folder may receive a message Klorn trashes or archives (step B2 of
 * docs/providers/unified-platform-plan.md). Same trust model as the Sent and
 * Drafts folders of step B3 (imap-send.ts): mail in the wrong folder is worse
 * than no move.
 *
 * A destination is used only when its role is trustworthy:
 *   - a SPECIAL-USE flag the server reported (`specialUseSource` "extension"), or
 *     the caller's own "user" hint, is trusted whatever the folder is called;
 *   - imapflow 1.7.0 also reports its looser name guesses as source "name" (for
 *     example "Deleted Items" or "Archive Mail"), so that source proves nothing.
 *     A name is trusted only when it is on the exact-name list for the role.
 *
 * The exact-name lists are EMPTY for both roles. The Naver and Apple help pages
 * B3 cites, fetched on 2026-09-30 without running their scripts, contained no IMAP
 * folder name for trash or archive, and no real listing has been recorded yet, so
 * none is invented. The flip checklist records what each server reports; adding a name
 * is a one-line change here. Naver is not known to have an archive folder (not
 * verified), so archive may be unsupported there.
 *
 * When there is no trustworthy folder the action is unsupported on that account,
 * and when two folders claim the same role nothing is guessed. INBOX is never a
 * destination.
 */

import type { ImapFlow, ListResponse } from "imapflow";

export type MoveRole = "\\Trash" | "\\Archive";

/** The part of imapflow's LIST entry the trust rules read. */
export type FolderEntry = Pick<
  ListResponse,
  "path" | "name" | "delimiter" | "flags" | "specialUse" | "specialUseSource"
>;

const UNSELECTABLE_FLAGS = ["\\Noselect", "\\NonExistent"] as const;
const INBOX_PATH = "INBOX";

/** Exact leaf names a NAME-sourced role may have. Empty until a real LIST documents one. */
const TRUSTED_NAME_LEAVES: Readonly<Record<MoveRole, readonly string[]>> = {
  "\\Trash": [],
  "\\Archive": [],
};

function leafName(folder: FolderEntry): string {
  return folder.name || folder.path.split(folder.delimiter || "/").pop() || folder.path;
}

function isTrustedFolder(folder: FolderEntry, role: MoveRole): boolean {
  if (folder.path.toUpperCase() === INBOX_PATH) return false;
  if (folder.specialUse !== role) return false;
  if (UNSELECTABLE_FLAGS.some((flag) => folder.flags?.has(flag))) return false;
  switch (folder.specialUseSource) {
    case "extension":
    case "user":
      return true;
    case "name":
      return TRUSTED_NAME_LEAVES[role].includes(leafName(folder).toLowerCase());
    default:
      return false;
  }
}

/** The path of the one trusted folder with this role, or null when there is none or it is ambiguous. */
export function findTrustedFolder(folders: readonly FolderEntry[], role: MoveRole): string | null {
  const trusted = folders.filter((folder) => isTrustedFolder(folder, role));
  return trusted.length === 1 ? trusted[0].path : null;
}

/** Resolves roles against one LIST of the mailbox, asked for at most once per session. */
export interface FolderFinder {
  find(role: MoveRole): Promise<string | null>;
}

export function createFolderFinder(client: ImapFlow): FolderFinder {
  let listing: Promise<FolderEntry[]> | undefined;
  return {
    find: async (role) => {
      listing ??= client.list();
      return findTrustedFolder(await listing, role);
    },
  };
}
