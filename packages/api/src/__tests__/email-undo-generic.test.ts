/**
 * Step B4: undo of a move on a generic IMAP mailbox re-syncs the restored message
 * exactly like Naver and iCloud (a MOVE back into INBOX gives it a new UID, hence a
 * new id). Only IMAP-family provider keys take that path.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ syncImapMessageForUser: vi.fn(), syncEmailByGmailId: vi.fn() }));

vi.mock("../mail/imap-accounts.js", () => ({
  syncImapMessageForUser: (...args: unknown[]) => m.syncImapMessageForUser(...args),
}));
vi.mock("../mail/email-sync.js", () => ({
  syncEmailByGmailId: (...args: unknown[]) => m.syncEmailByGmailId(...args),
}));

const { completeUndo } = await import("../routes/email-undo.js");
const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");
const { unsupportedMailActions } = await import("../mail/providers/unsupported.js");

const restored = { success: true as const, restoredMessageId: "generic-imap:me@example.com:205" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("completeUndo: restored IMAP message", () => {
  it("a generic mailbox re-syncs the restored message under the generic provider", async () => {
    m.syncImapMessageForUser.mockResolvedValue({ emailId: "e-9" });
    const out = await completeUndo(
      "u1",
      unsupportedMailActions("IMAP"),
      "generic-imap:me@example.com:101",
      "row-1",
      restored,
    );
    expect(out).toEqual({
      payload: { success: true, gmailId: "generic-imap:me@example.com:205", emailId: "e-9" },
    });
    expect(m.syncImapMessageForUser).toHaveBeenCalledWith(
      "u1",
      IMAP_PROVIDERS.IMAP,
      "row-1",
      "generic-imap:me@example.com:205",
    );
  });

  it("a generic mailbox whose re-sync fails says so with the provider label", async () => {
    m.syncImapMessageForUser.mockResolvedValue(null);
    const out = await completeUndo(
      "u1",
      unsupportedMailActions("IMAP"),
      "generic-imap:me@example.com:101",
      "row-1",
      restored,
    );
    expect(out).toEqual({
      failure:
        "Restored on IMAP, but Klorn could not refresh its copy. It will reappear after the next sync.",
    });
  });

  it("Naver still re-syncs under Naver", async () => {
    m.syncImapMessageForUser.mockResolvedValue({ emailId: "e-1" });
    await completeUndo(
      "u1",
      unsupportedMailActions("NAVER"),
      "naver-imap:me@naver.com:101",
      "row-2",
      { success: true, restoredMessageId: "naver-imap:me@naver.com:205" },
    );
    expect(m.syncImapMessageForUser).toHaveBeenCalledWith(
      "u1",
      IMAP_PROVIDERS.NAVER,
      "row-2",
      "naver-imap:me@naver.com:205",
    );
  });

  it.each(["GOOGLE", "OUTLOOK"] as const)("%s never takes the IMAP re-sync path", async (key) => {
    const out = await completeUndo("u1", unsupportedMailActions(key), "id", "row-3", restored);
    expect(out).toEqual({ failure: "Could not refresh the restored message." });
    expect(m.syncImapMessageForUser).not.toHaveBeenCalled();
  });
});
