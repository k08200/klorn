/**
 * Step B2 of docs/providers/unified-platform-plan.md: archive, trash and their
 * inverses for NAVER and ICLOUD, over IMAP MOVE.
 *
 * The server is a stateful fake (helpers/fake-imap-server.ts): folders with their
 * own UIDVALIDITY, a MOVE that assigns a NEW UID in the destination, and imapflow's
 * COPY + EXPUNGE fallback modelled so that any path reaching it is visible. The
 * database is the strict in-memory Prisma stand-in checked against the real
 * schema. What these pin:
 *
 *   - a move is a UID MOVE to a folder the server flagged (SPECIAL-USE) and never
 *     `\Deleted` + EXPUNGE, which is delete_permanent and sits on the floor;
 *   - where the message went (folder, new UID, that folder's UIDVALIDITY) is stored,
 *     and undo uses it to move the message back;
 *   - success only when the server confirmed the move (COPYUID, or a read-back);
 *   - a UID is acted on only when the live UIDVALIDITY equals the stored one and the
 *     UID still names the message Klorn has a row for;
 *   - an account with no trustworthy destination, or a server with no MOVE, is
 *     `unsupported` for that action, not a guess;
 *   - bursts coalesce into one login and one UID MOVE per destination, with the B1
 *     split-retry, through the same per-account queue as the flag actions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-db.js";
import { fakeServer } from "./helpers/fake-imap-server.js";
import {
  accountRow,
  deliver,
  ICLOUD,
  idOf,
  localIds,
  localRowFor,
  NAVER,
  newDb,
  USER,
} from "./helpers/imap-move-harness.js";

let db: FakeDb;

vi.mock("imapflow", async () => ({
  ImapFlow: (await import("./helpers/fake-imap-server.js")).FakeImapFlow,
}));
vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => db);
  return { prisma, db: prisma };
});
vi.mock("../crypto-tokens.js", () => ({ decryptToken: () => "app-pw" }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const { imapMoveActions } = await import("../mail/providers/imap-moves.js");
const { imapMailActions } = await import("../mail/providers/imap.js");
const { MAX_MOVE_COMMANDS_PER_RUN } = await import("../mail/providers/imap-move-run.js");
const { resetImapSessionState } = await import("../mail/providers/imap-session.js");

const naver = imapMoveActions("NAVER");
const icloud = imapMoveActions("ICLOUD");

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const moveCommands = () => fakeServer.commands.filter((c) => c.includes("MOVE"));
const errorOf = (result: unknown) => (result as { error?: string }).error;

function trackedRows() {
  return db.tables.imapMovedMessage ?? [];
}

beforeEach(() => {
  fakeServer.reset();
  db = newDb();
  resetImapSessionState();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await flush();
  // Whatever a test did, no path may have issued a permanent delete, and every
  // session must have ended with no mailbox lock left behind.
  expect(fakeServer.destructiveCommands).toEqual([]);
  expect(fakeServer.openLocks).toBe(0);
  expect(fakeServer.logouts).toBe(fakeServer.logins);
  vi.restoreAllMocks();
});

describe("trash", () => {
  it("moves the message to the flagged Trash folder with a UID MOVE and reports success", async () => {
    const id = deliver(db, NAVER, 101);

    const result = await naver.trash(USER, id, NAVER.rowId);

    expect(result).toEqual({ success: true });
    expect(moveCommands()).toEqual(["UID MOVE 101 Trash"]);
    expect(fakeServer.uidsIn("INBOX")).toEqual([]);
    expect(fakeServer.uidsIn("Trash")).toEqual([1]);
  });

  it("removes the local row, as the Gmail path does", async () => {
    const id = deliver(db, NAVER, 101);
    deliver(db, NAVER, 102);

    await naver.trash(USER, id, NAVER.rowId);

    expect(localIds(db)).toEqual([idOf(NAVER, 102)]);
  });

  it("stores where the message went: folder, the NEW uid, that folder's UIDVALIDITY, and what it looked like", async () => {
    const id = deliver(db, NAVER, 101, {
      subject: "Quarterly numbers",
      messageId: "<q3@example.com>",
    });

    await naver.trash(USER, id, NAVER.rowId);

    expect(trackedRows()).toHaveLength(1);
    expect(trackedRows()[0]).toMatchObject({
      userId: USER,
      linkedInboxAccountId: NAVER.rowId,
      sourceId: id,
      role: "TRASH",
      folderPath: "Trash",
      folderUid: 1n,
      folderUidValidity: "2000",
      messageIdHeader: "<q3@example.com>",
      subject: "Quarterly numbers",
    });
  });

  it("works the same for iCloud, with its own id prefix", async () => {
    const id = deliver(db, ICLOUD, 7);

    const result = await icloud.trash(USER, id, ICLOUD.rowId);

    expect(result).toEqual({ success: true });
    expect(trackedRows()[0]).toMatchObject({
      sourceId: idOf(ICLOUD, 7),
      linkedInboxAccountId: ICLOUD.rowId,
    });
  });

  it("needs the linked mailbox id", async () => {
    const id = deliver(db, NAVER, 101);

    const result = await naver.trash(USER, id, null);

    expect(errorOf(result)).toEqual(expect.stringContaining("Naver"));
    expect(fakeServer.logins).toBe(0);
    expect(localIds(db)).toEqual([id]);
  });
});

describe("archive", () => {
  it("moves the message to the flagged Archive folder", async () => {
    const id = deliver(db, NAVER, 101);

    const result = await naver.archive(USER, id, NAVER.rowId);

    expect(result).toEqual({ success: true });
    expect(moveCommands()).toEqual(["UID MOVE 101 Archive"]);
    expect(fakeServer.uidsIn("Archive")).toEqual([1]);
    expect(trackedRows()[0]).toMatchObject({
      role: "ARCHIVE",
      folderPath: "Archive",
      folderUidValidity: "3000",
    });
    expect(localIds(db)).toEqual([]);
  });
});

describe("never a permanent delete", () => {
  it("answers unsupported when the server has no MOVE, instead of letting imapflow COPY + EXPUNGE", async () => {
    const id = deliver(db, NAVER, 101);
    fakeServer.capabilities.delete("MOVE");

    const trash = await naver.trash(USER, id, NAVER.rowId);
    const archive = await naver.archive(USER, id, NAVER.rowId);

    expect(trash).toMatchObject({ unsupported: true, error: expect.stringContaining("MOVE") });
    expect(archive).toMatchObject({ unsupported: true });
    expect(fakeServer.uidsIn("INBOX")).toEqual([101]);
    expect(localIds(db)).toEqual([id]);
    // afterEach: destructiveCommands is empty, i.e. no COPY, \Deleted or EXPUNGE was sent.
  });
});

describe("destination trust", () => {
  it("is unsupported when the account has no folder the server flagged as Trash", async () => {
    const id = deliver(db, NAVER, 101);
    fakeServer.folders.delete("Trash");
    fakeServer.addFolder("Deleted Messages", 9n, {
      specialUse: "\\Trash",
      specialUseSource: "name",
    });

    const result = await naver.trash(USER, id, NAVER.rowId);

    expect(result).toMatchObject({ unsupported: true });
    expect(moveCommands()).toEqual([]);
    expect(localIds(db)).toEqual([id]);
  });

  it("still archives on an account whose Trash is untrusted", async () => {
    const id = deliver(db, NAVER, 101);
    fakeServer.folders.delete("Trash");

    expect(await naver.archive(USER, id, NAVER.rowId)).toEqual({ success: true });
  });

  it("is unsupported for archive when the account has no Archive folder (Naver may have none)", async () => {
    const id = deliver(db, NAVER, 101);
    fakeServer.folders.delete("Archive");

    const result = await naver.archive(USER, id, NAVER.rowId);

    expect(result).toMatchObject({ unsupported: true });
    expect(errorOf(result)).toEqual(expect.stringContaining("Archive"));
    expect(localIds(db)).toEqual([id]);
  });

  it("does not guess between two folders that claim the same role", async () => {
    const id = deliver(db, NAVER, 101);
    fakeServer.addFolder("Bin", 5n, { specialUse: "\\Trash", specialUseSource: "extension" });

    expect(await naver.trash(USER, id, NAVER.rowId)).toMatchObject({ unsupported: true });
  });

  it("asks for the folder list once per session, however many messages move", async () => {
    const ids = [101, 102, 103].map((uid) => deliver(db, NAVER, uid));

    await Promise.all(ids.map((id) => naver.archive(USER, id, NAVER.rowId)));

    expect(fakeServer.commands.filter((c) => c === "LIST")).toHaveLength(1);
  });
});

describe("UIDVALIDITY guard", () => {
  it("refuses, without a MOVE, when the live INBOX UIDVALIDITY differs from the stored one", async () => {
    const id = deliver(db, NAVER, 101);
    fakeServer.folder("INBOX").uidValidity = 1001n;

    const result = await naver.trash(USER, id, NAVER.rowId);

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(result).not.toHaveProperty("success");
    expect(moveCommands()).toEqual([]);
    expect(fakeServer.uidsIn("INBOX")).toEqual([101]);
    expect(localIds(db)).toEqual([id]);
    expect(trackedRows()).toEqual([]);
  });

  it("logs the refusal once, not once per call", async () => {
    const ids = [101, 102, 103].map((uid) => deliver(db, NAVER, uid));
    fakeServer.folder("INBOX").uidValidity = 1001n;

    await Promise.all(ids.map((id) => naver.trash(USER, id, NAVER.rowId)));
    await naver.archive(USER, ids[0], NAVER.rowId);

    const refusals = (
      console.warn as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.filter(([line]) => String(line).includes("UIDVALIDITY"));
    expect(refusals).toHaveLength(1);
    expect(String(refusals[0][0])).toContain(NAVER.rowId);
    expect(String(refusals[0][0])).not.toContain(NAVER.email);
  });

  it("refuses when no value was ever stored (the poller has not baselined this mailbox yet)", async () => {
    db = newDb({ accounts: [accountRow(NAVER, null)] });
    const id = deliver(db, NAVER, 101);

    const result = await naver.trash(USER, id, NAVER.rowId);

    expect(result).toMatchObject({ error: expect.stringContaining("sync") });
    expect(moveCommands()).toEqual([]);
  });

  it("refuses an INBOX id whose UID is a valid number but was minted under another validity, once the poller re-baselined", async () => {
    // After a reset the stored value equals the live one again, so the row's stale
    // UID would pass the validity check. The envelope guard is what stops it.
    const id = deliver(db, NAVER, 101, { subject: "Old message" });
    fakeServer.renumber("INBOX", 1001n);
    fakeServer.add("INBOX", { uid: 101, subject: "A completely different message" });
    db = newDb({ accounts: [accountRow(NAVER, "1001")], emails: db.tables.emailMessage });

    const result = await naver.trash(USER, id, NAVER.rowId);

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(moveCommands()).toEqual([]);
  });
});

describe("envelope guard", () => {
  it("refuses when the UID now holds a message with another subject", async () => {
    const id = deliver(db, NAVER, 101, { subject: "Invoice 42" });
    fakeServer.folder("INBOX").messages.get(101)!.subject = "Something else";

    const result = await naver.trash(USER, id, NAVER.rowId);

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(moveCommands()).toEqual([]);
    expect(localIds(db)).toEqual([id]);
  });

  it("refuses when the subject matches but the date does not", async () => {
    const id = deliver(db, NAVER, 101, { subject: "Weekly sync" });
    fakeServer.folder("INBOX").messages.get(101)!.date = new Date("2026-01-01T00:00:00Z");

    expect(await naver.archive(USER, id, NAVER.rowId)).toMatchObject({ error: expect.any(String) });
    expect(moveCommands()).toEqual([]);
  });

  it("compares the subject the way the poller stores it (trimmed, '(no subject)' when empty)", async () => {
    const id = deliver(db, NAVER, 101, { subject: "(no subject)" });
    fakeServer.folder("INBOX").messages.get(101)!.subject = "   ";

    expect(await naver.trash(USER, id, NAVER.rowId)).toEqual({ success: true });
  });

  it("goes by subject alone when the server message has no Date header", async () => {
    const id = deliver(db, NAVER, 101, { subject: "No date here", date: null });

    expect(await naver.trash(USER, id, NAVER.rowId)).toEqual({ success: true });
  });

  it("does not move a message Klorn has no row for", async () => {
    fakeServer.add("INBOX", { uid: 101 });

    const result = await naver.trash(USER, idOf(NAVER, 101), NAVER.rowId);

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(moveCommands()).toEqual([]);
  });
});

describe("a result is honest", () => {
  it("is an error, with the row kept, when the message is no longer in INBOX", async () => {
    const id = deliver(db, NAVER, 101);
    fakeServer.folder("INBOX").messages.delete(101);

    const result = await naver.trash(USER, id, NAVER.rowId);

    expect(result).toMatchObject({ error: expect.stringContaining("INBOX") });
    expect(result).not.toHaveProperty("success");
    expect(localIds(db)).toEqual([id]);
    expect(trackedRows()).toEqual([]);
  });

  it("is an error, with the row kept, when the server answers NO to the MOVE", async () => {
    const id = deliver(db, NAVER, 101);
    fakeServer.refuseMoveFor = new Set([101]);

    const result = await naver.trash(USER, id, NAVER.rowId);

    expect(result).toMatchObject({ error: expect.stringContaining("Naver") });
    expect(result).not.toHaveProperty("success");
    expect(fakeServer.uidsIn("INBOX")).toEqual([101]);
    expect(localIds(db)).toEqual([id]);
    expect(trackedRows()).toEqual([]);
  });

  it("confirms by reading the destination back when the server sends no COPYUID", async () => {
    const id = deliver(db, NAVER, 101, { messageId: "<readback@example.com>" });
    fakeServer.copyUid = false;

    const result = await naver.trash(USER, id, NAVER.rowId);

    expect(result).toEqual({ success: true });
    expect(trackedRows()[0]).toMatchObject({
      folderPath: "Trash",
      folderUid: 1n,
      folderUidValidity: "2000",
    });
    expect(localIds(db)).toEqual([]);
  });

  it("is an error when there is no COPYUID and the message cannot be found in the destination", async () => {
    const id = deliver(db, NAVER, 101, { messageId: "<gone@example.com>" });
    fakeServer.copyUid = false;
    // The server "moved" it, but a search of the destination finds nothing.
    fakeServer.searchFindsNothing = true;

    const result = await naver.trash(USER, id, NAVER.rowId);

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(result).not.toHaveProperty("success");
    expect(trackedRows()).toEqual([]);
    expect(localIds(db)).toEqual([id]);
  });

  it("is an error when there is no COPYUID and the message has no Message-ID to look for", async () => {
    const id = deliver(db, NAVER, 101, { messageId: null });
    fakeServer.copyUid = false;

    const result = await naver.trash(USER, id, NAVER.rowId);

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(trackedRows()).toEqual([]);
  });

  it("never throws, and answers an error, when the database fails before anything moved", async () => {
    const id = deliver(db, NAVER, 101);
    vi.spyOn(db.model("emailMessage"), "findFirst").mockRejectedValueOnce(
      new Error("pooler dropped"),
    );

    const result = await naver.trash(USER, id, NAVER.rowId);

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(moveCommands()).toEqual([]);
  });

  it("is still a success when the move was recorded nowhere: the message IS in Trash", async () => {
    const id = deliver(db, NAVER, 101);
    vi.spyOn(db.model("imapMovedMessage"), "upsert").mockRejectedValueOnce(new Error("boom"));

    const result = await naver.trash(USER, id, NAVER.rowId);

    expect(result).toEqual({ success: true });
    expect(localIds(db)).toEqual([]);
    expect(fakeServer.uidsIn("Trash")).toHaveLength(1);
  });

  it("answers an error, not a throw, when the local row cannot be removed after a confirmed move", async () => {
    const id = deliver(db, NAVER, 101);
    vi.spyOn(db.model("emailMessage"), "deleteMany").mockRejectedValueOnce(new Error("boom"));

    const result = await naver.trash(USER, id, NAVER.rowId);

    expect(result).toMatchObject({ error: expect.stringContaining("moved") });
    expect(fakeServer.uidsIn("Trash")).toHaveLength(1);
    expect(trackedRows()).toHaveLength(1);
  });

  it("a retry after that failure completes from the recorded move instead of failing forever", async () => {
    const id = deliver(db, NAVER, 101);
    vi.spyOn(db.model("emailMessage"), "deleteMany").mockRejectedValueOnce(new Error("boom"));
    await naver.trash(USER, id, NAVER.rowId);

    const retry = await naver.trash(USER, id, NAVER.rowId);

    expect(retry).toEqual({ success: true });
    expect(localIds(db)).toEqual([]);
    expect(moveCommands()).toEqual(["UID MOVE 101 Trash"]);
  });

  it("does not treat a message that was ARCHIVED as already trashed", async () => {
    const id = deliver(db, NAVER, 101);
    await naver.archive(USER, id, NAVER.rowId);
    // The local row is back (as after an undo and a poll) while the record says ARCHIVE.
    db.tables.emailMessage = [localRowFor(NAVER, 101)];

    const result = await naver.trash(USER, id, NAVER.rowId);

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(result).not.toHaveProperty("success");
    expect(localIds(db)).toEqual([id]);
  });
});

describe("what never reaches the server", () => {
  it.each([
    ["another mailbox's id", "naver-imap:someone@naver.com:101"],
    ["another provider's id", "icloud-imap:me@naver.com:101"],
    ["a Gmail id", "18c2f0a1b2c3d4e5"],
    ["a UID range", "naver-imap:me@naver.com:1:*"],
    ["a UID list", "naver-imap:me@naver.com:101,102"],
    ["a padded UID", "naver-imap:me@naver.com:0101"],
    ["an empty id", ""],
  ])("refuses %s before any connection", async (_name, messageId) => {
    // A local row and a recorded move exist under this very id, so only the strict
    // parse of the id stands between the action and a connection.
    const parked = (role: "TRASH" | "ARCHIVE") => ({
      id: `m-${role}`,
      userId: USER,
      linkedInboxAccountId: NAVER.rowId,
      sourceId: messageId,
      role,
      folderPath: role === "TRASH" ? "Trash" : "Archive",
      folderUid: 1n,
      folderUidValidity: role === "TRASH" ? "2000" : "3000",
      subject: "Subject 101",
    });
    db = newDb({
      emails: [{ ...localRowFor(NAVER, 101), gmailId: messageId }],
      moved: [parked("TRASH")],
    });
    deliver(db, NAVER, 101);

    for (const action of [naver.trash, naver.archive, naver.untrash]) {
      expect(await action(USER, messageId, NAVER.rowId)).toMatchObject({
        error: expect.any(String),
      });
    }
    db = newDb({ moved: [parked("ARCHIVE")] });
    expect(await naver.unarchive(USER, messageId, NAVER.rowId)).toMatchObject({
      error: expect.any(String),
    });
    expect(fakeServer.logins).toBe(0);
  });

  it("refuses another user's account before any connection", async () => {
    const id = deliver(db, NAVER, 101);

    const result = await naver.trash("someone-else", id, NAVER.rowId);

    expect(result).toMatchObject({ error: expect.stringContaining("not connected") });
    expect(fakeServer.logins).toBe(0);
    expect(localIds(db)).toEqual([id]);
  });

  it("refuses a NAVER action on an iCloud row", async () => {
    const id = deliver(db, ICLOUD, 101);

    const result = await naver.trash(USER, id, ICLOUD.rowId);

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(fakeServer.logins).toBe(0);
  });
});

describe("one login and one MOVE per destination", () => {
  it("coalesces a burst of archives into a single UID MOVE", async () => {
    const ids = [101, 102, 103, 104, 105].map((uid) => deliver(db, NAVER, uid));

    const results = await Promise.all(ids.map((id) => naver.archive(USER, id, NAVER.rowId)));

    expect(results).toEqual(ids.map(() => ({ success: true })));
    expect(fakeServer.logins).toBe(1);
    expect(moveCommands()).toEqual(["UID MOVE 101,102,103,104,105 Archive"]);
    expect(
      trackedRows()
        .map((row) => Number(row.folderUid))
        .sort(),
    ).toEqual([1, 2, 3, 4, 5]);
    expect(localIds(db)).toEqual([]);
  });

  it("keeps queue order: consecutive trashes merge, then consecutive archives", async () => {
    const ids = [101, 102, 103, 104].map((uid) => deliver(db, NAVER, uid));

    await Promise.all([
      naver.trash(USER, ids[0], NAVER.rowId),
      naver.trash(USER, ids[1], NAVER.rowId),
      naver.archive(USER, ids[2], NAVER.rowId),
      naver.archive(USER, ids[3], NAVER.rowId),
    ]);

    expect(fakeServer.logins).toBe(1);
    expect(moveCommands()).toEqual(["UID MOVE 101,102 Trash", "UID MOVE 103,104 Archive"]);
  });

  it("gives every caller its own result when one UID in the set is refused, by splitting", async () => {
    const ids = [101, 102, 103, 104].map((uid) => deliver(db, NAVER, uid));
    fakeServer.refuseMoveFor = new Set([102]);

    const results = await Promise.all(ids.map((id) => naver.archive(USER, id, NAVER.rowId)));

    expect(results[0]).toEqual({ success: true });
    expect(results[1]).toMatchObject({ error: expect.any(String) });
    expect(results[2]).toEqual({ success: true });
    expect(results[3]).toEqual({ success: true });
    expect(moveCommands()).toEqual([
      "UID MOVE 101,102,103,104 Archive",
      "UID MOVE 101,102 Archive",
      "UID MOVE 101 Archive",
      "UID MOVE 102 Archive",
      "UID MOVE 103,104 Archive",
    ]);
    expect(fakeServer.uidsIn("INBOX")).toEqual([102]);
    expect(localIds(db)).toEqual([idOf(NAVER, 102)]);
  });

  it("stops splitting after the command budget when the server refuses everything", async () => {
    const uids = Array.from({ length: 100 }, (_, i) => 101 + i);
    const ids = uids.map((uid) => deliver(db, NAVER, uid));
    fakeServer.refuseMoveFor = new Set(uids);

    const results = await Promise.all(ids.map((id) => naver.archive(USER, id, NAVER.rowId)));

    expect(results.every((r) => "error" in r)).toBe(true);
    expect(moveCommands().length).toBeLessThanOrEqual(MAX_MOVE_COMMANDS_PER_RUN);
    expect(fakeServer.uidsIn("INBOX")).toHaveLength(100);
    expect(localIds(db)).toHaveLength(100);
  });

  it("shares one session with flag actions queued for the same account", async () => {
    const ids = [101, 102].map((uid) => deliver(db, NAVER, uid));
    const flags = imapMailActions("NAVER");

    const [read, trashed] = await Promise.all([
      flags.markAsRead(USER, ids[0], NAVER.rowId),
      naver.trash(USER, ids[1], NAVER.rowId),
    ]);

    expect(read).toEqual({ success: true });
    expect(trashed).toEqual({ success: true });
    expect(fakeServer.logins).toBe(1);
    expect(fakeServer.folder("INBOX").messages.get(101)?.flags.has("\\Seen")).toBe(true);
  });

  it("runs two accounts' bursts in separate sessions", async () => {
    const a = deliver(db, NAVER, 101);
    const b = deliver(db, ICLOUD, 102);

    await Promise.all([naver.archive(USER, a, NAVER.rowId), icloud.archive(USER, b, ICLOUD.rowId)]);

    expect(fakeServer.logins).toBe(2);
  });
});

describe("untrash and unarchive", () => {
  it("moves a trashed message back to INBOX and names its NEW INBOX id", async () => {
    const id = deliver(db, NAVER, 101);
    await naver.trash(USER, id, NAVER.rowId);
    fakeServer.commands = [];

    const result = await naver.untrash(USER, id, NAVER.rowId);

    // The INBOX's next UID was 102; the restored message gets it, not its old 101.
    expect(result).toEqual({ success: true, restoredMessageId: idOf(NAVER, 102) });
    expect(moveCommands()).toEqual(["UID MOVE 1 INBOX"]);
    expect(fakeServer.uidsIn("INBOX")).toEqual([102]);
    expect(fakeServer.uidsIn("Trash")).toEqual([]);
  });

  it("consumes the record, so a second undo finds nothing to restore", async () => {
    const id = deliver(db, NAVER, 101);
    await naver.trash(USER, id, NAVER.rowId);
    await naver.untrash(USER, id, NAVER.rowId);
    expect(trackedRows()).toEqual([]);

    const again = await naver.untrash(USER, id, NAVER.rowId);

    expect(fakeServer.logins).toBe(2);
    expect(again).toMatchObject({ error: expect.any(String) });
    expect(again).not.toHaveProperty("success");
  });

  it("restores an archived message with unarchive", async () => {
    const id = deliver(db, NAVER, 101);
    await naver.archive(USER, id, NAVER.rowId);

    const result = await naver.unarchive(USER, id, NAVER.rowId);

    expect(result).toEqual({ success: true, restoredMessageId: idOf(NAVER, 102) });
    expect(fakeServer.uidsIn("Archive")).toEqual([]);
  });

  it("does not restore an archived message through untrash (the roles are separate)", async () => {
    const id = deliver(db, NAVER, 101);
    await naver.archive(USER, id, NAVER.rowId);
    fakeServer.commands = [];

    const result = await naver.untrash(USER, id, NAVER.rowId);

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(moveCommands()).toEqual([]);
    expect(fakeServer.uidsIn("Archive")).toHaveLength(1);
  });

  it("is an error, with no connection, when nothing was moved by Klorn", async () => {
    const result = await naver.untrash(USER, idOf(NAVER, 101), NAVER.rowId);

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(fakeServer.logins).toBe(0);
  });

  it("refuses when the Trash folder's UIDVALIDITY changed since the move", async () => {
    const id = deliver(db, NAVER, 101);
    await naver.trash(USER, id, NAVER.rowId);
    fakeServer.folder("Trash").uidValidity = 2001n;
    fakeServer.commands = [];

    const result = await naver.untrash(USER, id, NAVER.rowId);

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(moveCommands()).toEqual([]);
  });

  it("refuses when the recorded UID now names a different message, and drops the dead record", async () => {
    const id = deliver(db, NAVER, 101, { subject: "Original" });
    await naver.trash(USER, id, NAVER.rowId);
    const impostor = fakeServer.folder("Trash").messages.get(1)!;
    impostor.subject = "Not the original";
    impostor.messageId = "<someone-else@example.com>";
    fakeServer.commands = [];

    const result = await naver.untrash(USER, id, NAVER.rowId);

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(moveCommands()).toEqual([]);
    expect(trackedRows()).toEqual([]);
  });

  it("matches by Message-ID when the record has one, even if the subject was edited", async () => {
    const id = deliver(db, NAVER, 101, { subject: "Original", messageId: "<keep@example.com>" });
    await naver.trash(USER, id, NAVER.rowId);
    fakeServer.folder("Trash").messages.get(1)!.subject = "Re-filed subject";

    expect(await naver.untrash(USER, id, NAVER.rowId)).toMatchObject({ success: true });
  });

  it("is an error, and the record is dropped, when the message left the folder (Trash was emptied)", async () => {
    const id = deliver(db, NAVER, 101);
    await naver.trash(USER, id, NAVER.rowId);
    fakeServer.folder("Trash").messages.clear();

    const result = await naver.untrash(USER, id, NAVER.rowId);

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(trackedRows()).toEqual([]);
  });

  it("is an error when the destination folder itself is gone", async () => {
    const id = deliver(db, NAVER, 101);
    await naver.trash(USER, id, NAVER.rowId);
    fakeServer.folders.delete("Trash");

    const result = await naver.untrash(USER, id, NAVER.rowId);

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(result).not.toHaveProperty("success");
  });

  it("refuses when the INBOX was renumbered, before moving anything back into it", async () => {
    const id = deliver(db, NAVER, 101);
    await naver.trash(USER, id, NAVER.rowId);
    fakeServer.folder("INBOX").uidValidity = 1001n;
    fakeServer.commands = [];

    const result = await naver.untrash(USER, id, NAVER.rowId);

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(moveCommands()).toEqual([]);
    expect(fakeServer.uidsIn("Trash")).toHaveLength(1);
  });

  it("confirms the restore by reading INBOX back when the server sends no COPYUID", async () => {
    const id = deliver(db, NAVER, 101, { messageId: "<rb@example.com>" });
    await naver.trash(USER, id, NAVER.rowId);
    fakeServer.copyUid = false;

    const result = await naver.untrash(USER, id, NAVER.rowId);

    expect(result).toEqual({ success: true, restoredMessageId: idOf(NAVER, 102) });
  });

  it("coalesces a burst of restores from one folder into a single UID MOVE", async () => {
    const ids = [101, 102, 103].map((uid) => deliver(db, NAVER, uid));
    await Promise.all(ids.map((id) => naver.archive(USER, id, NAVER.rowId)));
    fakeServer.commands = [];
    fakeServer.logins = 0;
    fakeServer.logouts = 0;

    const results = await Promise.all(ids.map((id) => naver.unarchive(USER, id, NAVER.rowId)));

    expect(results.map((r) => ("restoredMessageId" in r ? r.restoredMessageId : null))).toEqual([
      idOf(NAVER, 104),
      idOf(NAVER, 105),
      idOf(NAVER, 106),
    ]);
    expect(fakeServer.logins).toBe(1);
    expect(moveCommands()).toEqual(["UID MOVE 1,2,3 INBOX"]);
  });
});

describe("retention", () => {
  it("sweeps records older than the retention window when the next move for the account is recorded", async () => {
    db = newDb({
      moved: [
        {
          id: "old",
          userId: USER,
          linkedInboxAccountId: NAVER.rowId,
          sourceId: idOf(NAVER, 5),
          role: "TRASH",
          folderPath: "Trash",
          folderUid: 9n,
          folderUidValidity: "2000",
          subject: "ancient",
          createdAt: new Date(Date.now() - 31 * 24 * 3600_000),
        },
      ],
    });
    const id = deliver(db, NAVER, 101);

    await naver.trash(USER, id, NAVER.rowId);

    expect(trackedRows().map((row) => row.sourceId)).toEqual([id]);
  });
});
