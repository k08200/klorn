/**
 * fetchStoredAttachmentBytes: a stored attachment row's bytes from the mailbox it
 * came from. Gmail as before; IMAP over the action session layer by UID and
 * section; Outlook through Graph `$value`. Lookups are scoped by user, and a row
 * whose message id is not its own mailbox's never reaches a server.
 */

import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.hoisted(() => vi.fn());
const resolveMailClient = vi.hoisted(() => vi.fn());
const attachmentsGet = vi.hoisted(() => vi.fn());
const resolveOutlookBearer = vi.hoisted(() => vi.fn());
const fetchOutlookAttachmentBytes = vi.hoisted(() => vi.fn());
const findCheckedAccount = vi.hoisted(() => vi.fn());
const imapClient = vi.hoisted(() => ({
  mailbox: { uidValidity: 1700n } as { uidValidity: unknown },
  getMailboxLock: vi.fn(),
  download: vi.fn(),
}));

vi.mock("../db.js", () => ({ prisma: { linkedInboxAccount: { findFirst } }, db: {} }));
vi.mock("../mail/gmail.js", () => ({ resolveMailClient }));
vi.mock("googleapis", () => ({
  google: { gmail: () => ({ users: { messages: { attachments: { get: attachmentsGet } } } }) },
}));
vi.mock("../mail/outlook-token.js", () => ({ resolveOutlookBearer }));
vi.mock("../mail/outlook-attachments.js", () => ({ fetchOutlookAttachmentBytes }));
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

const row = (gmailId: string, linkedInboxAccountId: string | null, partKey = "2") => ({
  gmailAttachmentId: partKey,
  partKey,
  email: { gmailId, linkedInboxAccountId },
});

beforeEach(() => {
  vi.clearAllMocks();
  imapClient.mailbox = { uidValidity: 1700n };
  imapClient.getMailboxLock.mockResolvedValue({ release: vi.fn() });
  findCheckedAccount.mockResolvedValue({
    id: "acc-icloud",
    email: "me@icloud.com",
    host: "imap.mail.me.com:993",
    passwordCipher: "c",
    inboxUidValidity: "1700",
  });
});

describe("fetchStoredAttachmentBytes → IMAP", () => {
  beforeEach(() => {
    findFirst.mockResolvedValue({ provider: "ICLOUD" });
  });

  it("downloads BODY[section] of the row's UID, scoped to the caller's account", async () => {
    imapClient.download.mockResolvedValue({ content: Readable.from([Buffer.from("%PDF")]) });

    const out = await fetchStoredAttachmentBytes(
      "u1",
      row("icloud-imap:me@icloud.com:42", "acc-icloud", "1.2"),
    );

    expect(out).toEqual({ ok: true, bytes: Buffer.from("%PDF") });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "acc-icloud", userId: "u1" } }),
    );
    expect(findCheckedAccount).toHaveBeenCalledWith(expect.anything(), "u1", "acc-icloud");
    expect(imapClient.download).toHaveBeenCalledWith("42", "1.2", {
      uid: true,
      maxBytes: MAX_ATTACHMENT_DOWNLOAD_BYTES + 1,
    });
  });

  it("refuses a message id of another mailbox and a malformed section without connecting", async () => {
    for (const r of [
      row("icloud-imap:other@icloud.com:42", "acc-icloud"),
      row("icloud-imap:me@icloud.com:42", "acc-icloud", "2 BODY[]"),
      row("icloud-imap:me@icloud.com:42", "acc-icloud", "../1"),
    ]) {
      expect(await fetchStoredAttachmentBytes("u1", r)).toMatchObject({ ok: false, status: 404 });
    }
    expect(imapClient.getMailboxLock).not.toHaveBeenCalled();
  });

  it("never serves a part once INBOX was renumbered (UIDVALIDITY changed)", async () => {
    imapClient.mailbox = { uidValidity: 9999n };

    const out = await fetchStoredAttachmentBytes(
      "u1",
      row("icloud-imap:me@icloud.com:42", "acc-icloud"),
    );

    expect(out).toMatchObject({ ok: false, status: 404 });
    expect(imapClient.download).not.toHaveBeenCalled();
  });

  it("answers 413 past the download cap", async () => {
    const big = Buffer.alloc(MAX_ATTACHMENT_DOWNLOAD_BYTES + 1);
    imapClient.download.mockResolvedValue({ content: Readable.from([big]) });

    const out = await fetchStoredAttachmentBytes(
      "u1",
      row("icloud-imap:me@icloud.com:42", "acc-icloud"),
    );

    expect(out).toMatchObject({ ok: false, status: 413 });
  });

  it("passes on the soft failure of an account that cannot connect", async () => {
    findCheckedAccount.mockResolvedValue({ error: "iCloud mailbox is not connected." });

    const out = await fetchStoredAttachmentBytes(
      "u1",
      row("icloud-imap:me@icloud.com:42", "acc-icloud"),
    );

    expect(out).toEqual({ ok: false, status: 409, error: "iCloud mailbox is not connected." });
  });
});

describe("fetchStoredAttachmentBytes → Outlook", () => {
  beforeEach(() => {
    findFirst.mockResolvedValue({ provider: "OUTLOOK" });
    resolveOutlookBearer.mockResolvedValue({ accessToken: "at", email: "me@outlook.com" });
  });

  it("fetches $value with the Graph id taken from the row's own mailbox prefix", async () => {
    fetchOutlookAttachmentBytes.mockResolvedValue({ bytes: Buffer.from("x") });

    const out = await fetchStoredAttachmentBytes(
      "u1",
      row("outlook:me@outlook.com:AAMk=", "acc-o", "att-1"),
    );

    expect(out).toEqual({ ok: true, bytes: Buffer.from("x") });
    expect(resolveOutlookBearer).toHaveBeenCalledWith("u1", "acc-o");
    expect(fetchOutlookAttachmentBytes).toHaveBeenCalledWith(
      "at",
      "AAMk=",
      "att-1",
      MAX_ATTACHMENT_DOWNLOAD_BYTES,
    );
  });

  it("refuses a message id of another mailbox", async () => {
    const out = await fetchStoredAttachmentBytes(
      "u1",
      row("outlook:other@outlook.com:AAMk=", "acc-o", "att-1"),
    );
    expect(out).toMatchObject({ ok: false, status: 404 });
    expect(fetchOutlookAttachmentBytes).not.toHaveBeenCalled();
  });
});

describe("fetchStoredAttachmentBytes → Gmail", () => {
  it("uses attachments.get with the row's handle, as before", async () => {
    resolveMailClient.mockResolvedValue({});
    attachmentsGet.mockResolvedValue({ data: { data: Buffer.from("g").toString("base64url") } });

    const out = await fetchStoredAttachmentBytes("u1", row("18c0ffee", null, "ANGjdJ"));

    expect(findFirst).not.toHaveBeenCalled();
    expect(attachmentsGet).toHaveBeenCalledWith({
      userId: "me",
      messageId: "18c0ffee",
      id: "ANGjdJ",
    });
    expect(out).toEqual({ ok: true, bytes: Buffer.from("g") });
  });

  it("treats another user's linked id like a stale one (no provider row → not connected)", async () => {
    findFirst.mockResolvedValue(null);
    resolveMailClient.mockResolvedValue(null);

    const out = await fetchStoredAttachmentBytes("u1", row("18c0ffee", "acc-of-someone-else"));

    expect(out).toMatchObject({ ok: false, status: 409 });
  });
});
