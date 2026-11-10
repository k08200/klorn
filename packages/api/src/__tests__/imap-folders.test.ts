/**
 * Which folder may receive a message Klorn trashes or archives (step B2 of
 * docs/providers/unified-platform-plan.md).
 *
 * Mail in the wrong folder is worse than no move, so a destination is used only
 * when its role is trustworthy: a SPECIAL-USE flag the server reported
 * (`specialUseSource` "extension", or the caller's own "user" hint). imapflow
 * 1.7.0 also reports its looser name guesses as source "name" (for example
 * "Deleted Items" or "Archive Mail"), which proves nothing, so a name is trusted
 * only when it is on the exact-name list for the role, and that list is empty for
 * both roles until a real Naver or iCloud LIST documents them. No trustworthy
 * folder means the action is unsupported on that account.
 */

import { describe, expect, it } from "vitest";
import { type FolderEntry, findTrustedFolder } from "../mail/providers/imap-folders.js";

const folder = (over: Partial<FolderEntry> & { path: string }): FolderEntry => ({
  name: over.path.split("/").pop() ?? over.path,
  delimiter: "/",
  flags: new Set<string>(),
  ...over,
});

const INBOX = folder({ path: "INBOX" });

describe("findTrustedFolder", () => {
  it("trusts a folder the server flagged with the role (SPECIAL-USE)", () => {
    const trash = folder({
      path: "Deleted Messages",
      specialUse: "\\Trash",
      specialUseSource: "extension",
    });
    expect(findTrustedFolder([INBOX, trash], "\\Trash")).toBe("Deleted Messages");
  });

  it("finds the archive role the same way", () => {
    const archive = folder({
      path: "Archive",
      specialUse: "\\Archive",
      specialUseSource: "extension",
    });
    expect(findTrustedFolder([INBOX, archive], "\\Archive")).toBe("Archive");
  });

  it("trusts the caller's own hint", () => {
    const trash = folder({ path: "Bin", specialUse: "\\Trash", specialUseSource: "user" });
    expect(findTrustedFolder([trash], "\\Trash")).toBe("Bin");
  });

  it("does not use a role that came from a name guess, even an exact-looking one", () => {
    const guessed = [
      folder({ path: "Trash", specialUse: "\\Trash", specialUseSource: "name" }),
      folder({ path: "Deleted Messages", specialUse: "\\Trash", specialUseSource: "name" }),
      folder({ path: "Archive", specialUse: "\\Archive", specialUseSource: "name" }),
      folder({ path: "Trash Mail", specialUse: "\\Trash", specialUseSource: "name" }),
    ];
    expect(findTrustedFolder(guessed, "\\Trash")).toBeNull();
    expect(findTrustedFolder(guessed, "\\Archive")).toBeNull();
  });

  it("does not use a role with no source", () => {
    expect(
      findTrustedFolder([folder({ path: "Trash", specialUse: "\\Trash" })], "\\Trash"),
    ).toBeNull();
  });

  it("does not use a folder that cannot be selected", () => {
    const noselect = folder({
      path: "Trash",
      specialUse: "\\Trash",
      specialUseSource: "extension",
      flags: new Set(["\\Noselect"]),
    });
    const nonexistent = folder({
      path: "Trash2",
      specialUse: "\\Trash",
      specialUseSource: "extension",
      flags: new Set(["\\NonExistent"]),
    });
    expect(findTrustedFolder([noselect], "\\Trash")).toBeNull();
    expect(findTrustedFolder([nonexistent], "\\Trash")).toBeNull();
  });

  it("does not mix the two roles", () => {
    const trash = folder({ path: "Trash", specialUse: "\\Trash", specialUseSource: "extension" });
    expect(findTrustedFolder([trash], "\\Archive")).toBeNull();
  });

  it("is null when the mailbox has no such folder", () => {
    expect(findTrustedFolder([INBOX], "\\Trash")).toBeNull();
    expect(findTrustedFolder([], "\\Archive")).toBeNull();
  });

  it("refuses to guess when two trusted folders claim the same role", () => {
    const a = folder({ path: "Trash", specialUse: "\\Trash", specialUseSource: "extension" });
    const b = folder({ path: "Bin", specialUse: "\\Trash", specialUseSource: "extension" });
    expect(findTrustedFolder([a, b], "\\Trash")).toBeNull();
  });

  it("never offers INBOX as a destination", () => {
    const odd = folder({ path: "INBOX", specialUse: "\\Archive", specialUseSource: "extension" });
    expect(findTrustedFolder([odd], "\\Archive")).toBeNull();
  });

  it("keeps a nested path whole", () => {
    const nested = folder({
      path: "INBOX/Archive",
      name: "Archive",
      specialUse: "\\Archive",
      specialUseSource: "extension",
    });
    expect(findTrustedFolder([nested], "\\Archive")).toBe("INBOX/Archive");
  });
});
