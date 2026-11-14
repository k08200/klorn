/**
 * fetchStoredAttachmentBytes for an IMAP row whose message left INBOX (the user
 * archived or moved it in another client, so the local row is still there). The
 * stored UID no longer serves the part, so the message is looked up by its stored
 * RFC 5322 Message-ID in the account's other role folders: \Archive, \All, \Sent,
 * \Trash, \Junk, each only when its role is trusted (imap-folders.ts). IMAP header
 * SEARCH is a substring match, so every candidate's envelope must carry exactly the
 * stored Message-ID, and exactly one candidate may. One mailbox lock at a time.
 *
 * The server is faked: folders with SPECIAL-USE roles, a SEARCH that matches
 * loosely (as real servers may), and a lock that fails the test when a second one
 * is asked for while one is held (imapflow would wait forever).
 */

import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakeMessage {
  uid: number;
  messageId: string | null;
  parts: Record<string, Buffer>;
}

interface FakeFolder {
  path: string;
  specialUse?: string;
  specialUseSource?: string;
  flags?: Set<string>;
  uidValidity: bigint;
  messages: FakeMessage[];
}

const server = vi.hoisted(() => ({
  folders: [] as FakeFolder[],
  selected: null as string | null,
  held: 0,
  events: [] as string[],
}));

const folderAt = (path: string | null): FakeFolder | undefined =>
  server.folders.find((f) => f.path === path);

function selectedFolder(): FakeFolder {
  if (server.held !== 1) throw new Error("command without exactly one mailbox lock held");
  const folder = folderAt(server.selected);
  if (!folder) throw new Error("no mailbox selected");
  return folder;
}

/** Loose, like a real server: case-insensitive substring, angle brackets ignored. */
const loose = (value: string) => value.replace(/[<>]/g, "").toLowerCase();

const imapClient = vi.hoisted(() => ({
  get mailbox() {
    const folder = server.folders.find((f) => f.path === server.selected);
    return folder ? { path: folder.path, uidValidity: folder.uidValidity } : false;
  },
  getMailboxLock: vi.fn(),
  list: vi.fn(),
  search: vi.fn(),
  fetchAll: vi.fn(),
  download: vi.fn(),
}));

const findFirst = vi.hoisted(() => vi.fn());
const findCheckedAccount = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({ prisma: { linkedInboxAccount: { findFirst } }, db: {} }));
vi.mock("../mail/gmail.js", () => ({ resolveMailClient: vi.fn() }));
vi.mock("../mail/outlook-token.js", () => ({ resolveOutlookBearer: vi.fn() }));
vi.mock("../mail/outlook-attachments.js", () => ({ fetchOutlookAttachmentBytes: vi.fn() }));
vi.mock("../mail/providers/imap-account.js", () => ({
  findCheckedAccount,
  sessionAccountFor: vi.fn((_p, userId, checked) => ({ userId, rowId: checked.id })),
}));
vi.mock("../mail/providers/imap-session.js", () => ({
  runAccountTask: vi.fn((_p, _a, task) => task({ signal: new AbortController().signal })),
  withImapClient: vi.fn((_p, _a, run) => run(imapClient)),
}));

const { fetchStoredAttachmentBytes, MAX_ATTACHMENT_DOWNLOAD_BYTES } = await import(
  "../mail/attachment-bytes.js"
);

const MESSAGE_ID = "<abc@x.example.com>";
const PDF = Buffer.from("%PDF-1.7 archived");

const message = (uid: number, messageId: string | null, part = PDF): FakeMessage => ({
  uid,
  messageId,
  parts: { "2": part },
});

const inbox = (messages: FakeMessage[] = [], uidValidity = 1700n): FakeFolder => ({
  path: "INBOX",
  uidValidity,
  messages,
});

const roleFolder = (
  path: string,
  specialUse: string,
  messages: FakeMessage[] = [],
  specialUseSource = "extension",
): FakeFolder => ({ path, specialUse, specialUseSource, uidValidity: 9n, messages });

const row = (
  messageIdHeader: string | null | undefined,
  gmailId = "icloud-imap:me@icloud.com:42",
) => ({
  gmailAttachmentId: "2",
  partKey: "2",
  email: { gmailId, linkedInboxAccountId: "acc-icloud", messageIdHeader },
});

const fetchRow = (r: ReturnType<typeof row>) => fetchStoredAttachmentBytes("u1", r);

beforeEach(() => {
  vi.clearAllMocks();
  server.folders = [];
  server.selected = null;
  server.held = 0;
  server.events = [];
  findFirst.mockResolvedValue({ provider: "ICLOUD" });
  findCheckedAccount.mockResolvedValue({
    id: "acc-icloud",
    email: "me@icloud.com",
    host: "imap.mail.me.com:993",
    passwordCipher: "c",
    inboxUidValidity: "1700",
  });
  imapClient.getMailboxLock.mockImplementation(async (path: string) => {
    if (server.held > 0) throw new Error(`second lock on ${path} while one is held`);
    if (!folderAt(path)) throw new Error(`no mailbox ${path}`);
    server.held += 1;
    server.selected = path;
    server.events.push(`lock ${path}`);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        server.held -= 1;
        server.events.push(`release ${path}`);
      },
    };
  });
  imapClient.list.mockImplementation(async () =>
    server.folders.map((f) => ({
      path: f.path,
      name: f.path.split("/").pop(),
      delimiter: "/",
      flags: f.flags ?? new Set<string>(),
      specialUse: f.specialUse,
      specialUseSource: f.specialUseSource,
    })),
  );
  imapClient.search.mockImplementation(async (query: { header: Record<string, string> }) => {
    const needle = loose(query.header["message-id"] ?? "");
    return selectedFolder()
      .messages.filter((m) => m.messageId !== null && loose(m.messageId).includes(needle))
      .map((m) => m.uid);
  });
  imapClient.fetchAll.mockImplementation(async (uids: number[]) =>
    selectedFolder()
      .messages.filter((m) => uids.includes(m.uid))
      .map((m) => ({ uid: m.uid, envelope: { messageId: m.messageId } })),
  );
  imapClient.download.mockImplementation(async (uid: string, section: string) => {
    const part = selectedFolder().messages.find((m) => String(m.uid) === uid)?.parts[section];
    return part ? { content: Readable.from([part]) } : {};
  });
});

describe("IMAP attachment download beyond INBOX", () => {
  it("(a) serves an INBOX hit exactly as before, without listing or searching other folders", async () => {
    server.folders = [inbox([message(42, MESSAGE_ID)]), roleFolder("Archive", "\\Archive")];

    const out = await fetchRow(row(MESSAGE_ID));

    expect(out).toEqual({ ok: true, bytes: PDF });
    expect(imapClient.download).toHaveBeenCalledWith("42", "2", {
      uid: true,
      maxBytes: MAX_ATTACHMENT_DOWNLOAD_BYTES + 1,
    });
    expect(imapClient.list).not.toHaveBeenCalled();
    expect(imapClient.search).not.toHaveBeenCalled();
    expect(server.events).toEqual(["lock INBOX", "release INBOX"]);
  });

  it("(b) finds a message moved to the \\Archive folder by its exact Message-ID", async () => {
    server.folders = [
      inbox([]),
      roleFolder("Archive", "\\Archive", [
        message(7, "<other@x.example.com>"),
        message(9, MESSAGE_ID),
      ]),
    ];

    const out = await fetchRow(row(MESSAGE_ID));

    expect(out).toEqual({ ok: true, bytes: PDF });
    expect(imapClient.search).toHaveBeenCalledWith(
      { header: { "message-id": MESSAGE_ID } },
      { uid: true },
    );
    expect(imapClient.download).toHaveBeenLastCalledWith("9", "2", {
      uid: true,
      maxBytes: MAX_ATTACHMENT_DOWNLOAD_BYTES + 1,
    });
    expect(server.events).toEqual([
      "lock INBOX",
      "release INBOX",
      "lock Archive",
      "release Archive",
    ]);
  });

  it("(b) also looks once INBOX was renumbered, never trusting the stored UID there", async () => {
    server.folders = [
      inbox([message(42, "<someone-else@x.example.com>")], 9999n),
      roleFolder("Archive", "\\Archive", [message(3, MESSAGE_ID)]),
    ];

    const out = await fetchRow(row(MESSAGE_ID));

    expect(out).toEqual({ ok: true, bytes: PDF });
    expect(imapClient.download).toHaveBeenCalledTimes(1);
    expect(imapClient.download).toHaveBeenCalledWith("3", "2", expect.anything());
  });

  it("(c) finds it in \\Sent after \\Archive and \\All came up empty, in role order", async () => {
    server.folders = [
      inbox([]),
      roleFolder("Junk", "\\Junk"),
      roleFolder("Sent Messages", "\\Sent", [message(5, MESSAGE_ID)]),
      roleFolder("All Mail", "\\All"),
      roleFolder("Archive", "\\Archive"),
    ];

    const out = await fetchRow(row(MESSAGE_ID));

    expect(out).toEqual({ ok: true, bytes: PDF });
    expect(server.events.filter((e) => e.startsWith("lock"))).toEqual([
      "lock INBOX",
      "lock Archive",
      "lock All Mail",
      "lock Sent Messages",
    ]);
  });

  it("(d) never serves a candidate whose Message-ID only contains the stored one", async () => {
    server.folders = [
      inbox([]),
      roleFolder("Archive", "\\Archive", [message(8, "<xabc@x.example.com>")]),
      roleFolder("Trash", "\\Trash", [message(4, `${MESSAGE_ID} trailing`)]),
    ];

    const out = await fetchRow(row(MESSAGE_ID));

    expect(out).toMatchObject({ ok: false, status: 404 });
    // The loose SEARCH did offer them; the envelope check refused both.
    expect(imapClient.fetchAll).toHaveBeenCalled();
    expect(imapClient.download).toHaveBeenCalledTimes(1); // the INBOX attempt only
  });

  it("(d) compares case-sensitively", async () => {
    server.folders = [
      inbox([]),
      roleFolder("Archive", "\\Archive", [message(8, MESSAGE_ID.toUpperCase())]),
    ];

    expect(await fetchRow(row(MESSAGE_ID))).toMatchObject({ ok: false, status: 404 });
  });

  it("(e) refuses two exact matches, and does not go on to serve a copy elsewhere", async () => {
    server.folders = [
      inbox([]),
      roleFolder("Archive", "\\Archive", [message(1, MESSAGE_ID), message(2, MESSAGE_ID)]),
      roleFolder("Sent", "\\Sent", [message(6, MESSAGE_ID)]),
    ];

    const out = await fetchRow(row(MESSAGE_ID));

    expect(out).toMatchObject({ ok: false, status: 404 });
    expect(imapClient.download).toHaveBeenCalledTimes(1); // the INBOX attempt only
    expect(server.events).not.toContain("lock Sent");
  });

  it("(f) a row without a stored Message-ID answers 404 as before, without any folder search", async () => {
    server.folders = [inbox([]), roleFolder("Archive", "\\Archive", [message(9, MESSAGE_ID)])];

    for (const header of [null, undefined]) {
      expect(await fetchRow(row(header))).toMatchObject({ ok: false, status: 404 });
    }
    expect(imapClient.list).not.toHaveBeenCalled();
    expect(imapClient.search).not.toHaveBeenCalled();
  });

  it("(g) answers 413 for an over-cap part found outside INBOX", async () => {
    const big = Buffer.alloc(MAX_ATTACHMENT_DOWNLOAD_BYTES + 1);
    server.folders = [inbox([]), roleFolder("Archive", "\\Archive", [message(9, MESSAGE_ID, big)])];

    expect(await fetchRow(row(MESSAGE_ID))).toMatchObject({ ok: false, status: 413 });
    expect(server.held).toBe(0);
  });

  it("(h) holds one lock at a time and releases it on every path, a throw included", async () => {
    server.folders = [
      inbox([]),
      roleFolder("Archive", "\\Archive"),
      roleFolder("All Mail", "\\All"),
      roleFolder("Sent", "\\Sent"),
      roleFolder("Trash", "\\Trash"),
      roleFolder("Junk", "\\Junk"),
    ];

    expect(await fetchRow(row(MESSAGE_ID))).toMatchObject({ ok: false, status: 404 });
    expect(server.held).toBe(0);
    expect(server.events).toEqual([
      "lock INBOX",
      "release INBOX",
      "lock Archive",
      "release Archive",
      "lock All Mail",
      "release All Mail",
      "lock Sent",
      "release Sent",
      "lock Trash",
      "release Trash",
      "lock Junk",
      "release Junk",
    ]);

    // A failing command throws out of the task (the real session layer turns that
    // into its soft failure); the lock is released first.
    server.events = [];
    imapClient.search.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(fetchRow(row(MESSAGE_ID))).rejects.toThrow("socket hang up");
    expect(server.held).toBe(0);
    expect(server.events).toEqual([
      "lock INBOX",
      "release INBOX",
      "lock Archive",
      "release Archive",
    ]);
  });

  it("looks only in trusted role folders: never INBOX again, never \\Noselect, never a guessed name", async () => {
    server.folders = [
      inbox([]),
      roleFolder("Archive", "\\Archive", [message(9, MESSAGE_ID)], "name"),
      {
        ...roleFolder("Trash", "\\Trash", [message(9, MESSAGE_ID)]),
        flags: new Set(["\\Noselect"]),
      },
      roleFolder("Projects", "", [message(9, MESSAGE_ID)]),
    ];

    expect(await fetchRow(row(MESSAGE_ID))).toMatchObject({ ok: false, status: 404 });
    expect(server.events).toEqual(["lock INBOX", "release INBOX"]);
  });

  it("bounds the work: a folder with too many candidates is not resolved", async () => {
    const many = Array.from({ length: 6 }, (_, i) => message(i + 1, `<${i}abc@x.example.com>`));
    server.folders = [
      inbox([]),
      roleFolder("Archive", "\\Archive", [...many, message(99, MESSAGE_ID)]),
    ];

    expect(await fetchRow(row(MESSAGE_ID))).toMatchObject({ ok: false, status: 404 });
    expect(imapClient.fetchAll).not.toHaveBeenCalled();
    expect(server.held).toBe(0);
  });

  it("keeps the mailbox scoping: a message id of another account never reaches a server", async () => {
    server.folders = [inbox([]), roleFolder("Archive", "\\Archive", [message(9, MESSAGE_ID)])];

    const out = await fetchRow(row(MESSAGE_ID, "icloud-imap:other@icloud.com:42"));

    expect(out).toMatchObject({ ok: false, status: 404 });
    expect(imapClient.getMailboxLock).not.toHaveBeenCalled();
  });
});
