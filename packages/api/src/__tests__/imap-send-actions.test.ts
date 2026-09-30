/**
 * Step B3 of docs/providers/unified-platform-plan.md: send, reply and drafts for
 * NAVER and ICLOUD over SMTP and IMAP.
 *
 * nodemailer's transport and the imapflow client are faked (there is no public
 * Naver or iCloud sandbox). These pin: the SMTP endpoint and TLS options come
 * from the registry only, a row with a tampered host is refused before any
 * connection, the recipient guard, the MIME and envelope handed to SMTP (From is
 * the linked account, reply threading headers present), the Sent copy (found by
 * special-use, APPENDed only when the server did not already store it), drafts
 * (APPEND to \Drafts with \Draft), reply headers fetched by strict UID, the auth
 * cooldown shared with the B1 flag actions in both directions, transport
 * failures as `{ error }`, per-account serialization and the global cap, and
 * that neither a credential nor a full `<prefix>:<email>:<uid>` reaches a log.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  createTransport: vi.fn(),
  sendMail: vi.fn(),
  transportClose: vi.fn(),
  imapCtorOpts: [] as Array<Record<string, unknown>>,
  connect: vi.fn(),
  list: vi.fn(),
  getMailboxLock: vi.fn(),
  search: vi.fn(),
  append: vi.fn(),
  fetchOne: vi.fn(),
  fetch: vi.fn(),
  messageFlagsAdd: vi.fn(),
  messageFlagsRemove: vi.fn(),
  logout: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
  release: vi.fn(),
  findFirst: vi.fn(),
  decryptToken: vi.fn(),
  captureError: vi.fn(),
}));

class FakeImapFlow {
  constructor(opts: Record<string, unknown>) {
    h.imapCtorOpts.push(opts);
  }
  connect = h.connect;
  list = h.list;
  getMailboxLock = h.getMailboxLock;
  search = h.search;
  append = h.append;
  fetchOne = h.fetchOne;
  fetch = h.fetch;
  messageFlagsAdd = h.messageFlagsAdd;
  messageFlagsRemove = h.messageFlagsRemove;
  logout = h.logout;
  close = h.close;
  on = h.on;
}

vi.mock("imapflow", () => ({ ImapFlow: FakeImapFlow }));
vi.mock("nodemailer", () => ({ createTransport: h.createTransport }));
vi.mock("../db.js", () => {
  const prisma = {
    linkedInboxAccount: { findFirst: h.findFirst },
    emailMessage: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  return { prisma, db: prisma };
});
vi.mock("../crypto-tokens.js", () => ({ decryptToken: h.decryptToken }));
vi.mock("../sentry.js", () => ({ captureError: h.captureError }));

const { imapSendActions } = await import("../mail/providers/imap-send.js");
const { imapMailActions } = await import("../mail/providers/imap.js");
const {
  MAX_CONCURRENT_IMAP_ACTION_SESSIONS,
  resetImapSessionState,
  IMAP_ACTION_CONNECT_TIMEOUT_MS,
  IMAP_ACTION_GREETING_TIMEOUT_MS,
  IMAP_ACTION_SOCKET_TIMEOUT_MS,
} = await import("../mail/providers/imap-session.js");
const { SMTP_CONNECTION_TIMEOUT_MS, SMTP_GREETING_TIMEOUT_MS, SMTP_SOCKET_TIMEOUT_MS } =
  await import("../mail/smtp-transport.js");

const PASSWORD = "sup3r-secret-app-pw";
const CIPHER = "v2:k:iv:ct:tag";
const NAVER_ROW = {
  id: "row-1",
  email: "me@naver.com",
  imapHost: "imap.naver.com:993",
  imapPasswordCipher: CIPHER,
};
const ICLOUD_ROW = {
  id: "row-2",
  email: "me@icloud.com",
  imapHost: "imap.mail.me.com:993",
  imapPasswordCipher: CIPHER,
};
const NAVER_MSG = "naver-imap:me@naver.com:101";
const ORIGINAL_ID = "<orig-1@mail.example.com>";

const draftInput = { to: "bob@example.com", subject: "Re: Hi", body: "Draft body" };

const naver = imapSendActions("NAVER");
const icloud = imapSendActions("ICLOUD");

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const FOLDERS = [
  { path: "INBOX", specialUse: "\\Inbox", flags: new Set<string>() },
  {
    path: "Sent Messages",
    specialUse: "\\Sent",
    specialUseSource: "extension",
    flags: new Set<string>(),
  },
  { path: "Drafts", specialUse: "\\Drafts", specialUseSource: "name", flags: new Set<string>() },
  {
    path: "Sent Items",
    specialUse: "\\Sent",
    specialUseSource: "name-guess",
    flags: new Set<string>(),
  },
];

const authRejected = () =>
  Object.assign(new Error("Invalid login: 535 5.7.8 authentication failed"), {
    code: "EAUTH",
    responseCode: 535,
  });
const imapAuthRejected = () =>
  Object.assign(new Error("Command failed"), {
    authenticationFailed: true,
    serverResponseCode: "AUTHENTICATIONFAILED",
  });

function arm(row: Record<string, unknown> | null = NAVER_ROW) {
  h.findFirst.mockImplementation(async () => row);
  h.decryptToken.mockReturnValue(PASSWORD);
  h.createTransport.mockImplementation(() => ({ sendMail: h.sendMail, close: h.transportClose }));
  h.sendMail.mockResolvedValue({ accepted: ["bob@example.com"], rejected: [] });
  h.connect.mockResolvedValue(undefined);
  h.list.mockResolvedValue(FOLDERS);
  h.getMailboxLock.mockResolvedValue({ release: h.release });
  h.search.mockResolvedValue([]);
  h.append.mockResolvedValue({ destination: "Sent Messages", uid: 7 });
  h.fetchOne.mockResolvedValue({
    uid: 101,
    headers: Buffer.from(
      `Message-ID: ${ORIGINAL_ID}\r\nReferences: <root@x.example>\r\n <mid@x.example>\r\n\r\n`,
    ),
  });
  h.logout.mockResolvedValue(undefined);
}

function loggedText(): string {
  const spies = [console.warn, console.error, console.log] as unknown as Array<{
    mock: { calls: unknown[][] };
  }>;
  return spies
    .flatMap((spy) => spy.mock.calls)
    .map((args) => args.map(String).join(" "))
    .join("\n");
}

const sentRaw = () => h.sendMail.mock.calls[0][0].raw as Buffer;
const sentMime = () => sentRaw().toString("utf-8");
const header = (mime: string, name: string) =>
  new RegExp(`^${name}: (.*)$`, "mi").exec(mime.split("\r\n\r\n")[0])?.[1];

beforeEach(() => {
  for (const fn of Object.values(h))
    if (typeof fn === "function" && "mockReset" in fn) fn.mockReset();
  h.imapCtorOpts.length = 0;
  resetImapSessionState();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  arm();
});
afterEach(() => vi.restoreAllMocks());

describe("sendEmail — SMTP", () => {
  it("connects to the registry host with the registry TLS mode and the account's credentials", async () => {
    await naver.sendEmail("u1", "bob@example.com", "Hi", "Hello", [], {
      linkedInboxAccountId: "row-1",
    });
    expect(h.createTransport).toHaveBeenCalledTimes(1);
    const opts = h.createTransport.mock.calls[0][0];
    expect(opts).toMatchObject({
      host: "smtp.naver.com",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: "me@naver.com", pass: PASSWORD },
      connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
      greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
      socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
    });
    expect(opts.tls).toMatchObject({ rejectUnauthorized: true });
  });

  it("iCloud uses smtp.mail.me.com:587 with STARTTLS required", async () => {
    const icloudRow = ICLOUD_ROW;
    arm(icloudRow);
    await icloud.sendEmail("u1", "bob@example.com", "Hi", "Hello", [], {
      linkedInboxAccountId: "row-2",
    });
    expect(h.createTransport.mock.calls[0][0]).toMatchObject({
      host: "smtp.mail.me.com",
      port: 587,
      requireTLS: true,
      auth: { user: "me@icloud.com", pass: PASSWORD },
    });
  });

  it("sends the MIME with From = the linked account, and an envelope that matches it", async () => {
    const result = await naver.sendEmail("u1", "Bob <bob@example.com>", "Hi", "Hello", [], {
      linkedInboxAccountId: "row-1",
    });
    const mime = sentMime();
    expect(h.sendMail.mock.calls[0][0].envelope).toEqual({
      from: "me@naver.com",
      to: ["bob@example.com"],
    });
    expect(header(mime, "From")).toBe("me@naver.com");
    expect(header(mime, "To")).toBe("bob@example.com");
    expect(header(mime, "Subject")).toBe(`=?UTF-8?B?${Buffer.from("Hi").toString("base64")}?=`);
    expect(header(mime, "Date")).toMatch(/^\w{3}, \d{1,2} \w{3} \d{4} \d\d:\d\d:\d\d \+0000$/);
    const messageId = header(mime, "Message-ID");
    expect(messageId).toMatch(/^<[0-9a-f-]{36}@naver\.com>$/);
    expect(result).toEqual({ success: true, messageId, threadId: null });
  });

  it("carries reply threading headers as parsed message ids", async () => {
    await naver.sendEmail("u1", "bob@example.com", "Re: Hi", "Hello", [], {
      linkedInboxAccountId: "row-1",
      inReplyTo: `text ${ORIGINAL_ID}`,
      references: `<root@x.example> <mid@x.example> ${ORIGINAL_ID}`,
    });
    const mime = sentMime();
    expect(header(mime, "In-Reply-To")).toBe(ORIGINAL_ID);
    expect(header(mime, "References")).toBe(`<root@x.example> <mid@x.example> ${ORIGINAL_ID}`);
  });

  it("omits threading headers when the send is not a reply", async () => {
    await naver.sendEmail("u1", "bob@example.com", "Hi", "Hello", [], {
      linkedInboxAccountId: "row-1",
    });
    expect(header(sentMime(), "In-Reply-To")).toBeUndefined();
    expect(header(sentMime(), "References")).toBeUndefined();
  });

  it("includes attachments through the shared builder", async () => {
    await naver.sendEmail(
      "u1",
      "bob@example.com",
      "Hi",
      "Hello",
      [{ filename: "a.txt", mimeType: "text/plain", content: Buffer.from("hello") }],
      { linkedInboxAccountId: "row-1" },
    );
    expect(sentMime()).toContain("multipart/mixed");
    expect(sentMime()).toContain(Buffer.from("hello").toString("base64"));
  });

  it("closes the transport after the send, success or failure", async () => {
    await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    expect(h.transportClose).toHaveBeenCalledTimes(1);
    h.sendMail.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "ETIMEDOUT" }));
    await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    expect(h.transportClose).toHaveBeenCalledTimes(2);
  });

  it("does not mutate its inputs", async () => {
    const attachments = Object.freeze([
      Object.freeze({ filename: "a.txt", mimeType: "text/plain", content: Buffer.from("x") }),
    ]) as unknown as Array<{ filename: string; mimeType: string; content: Buffer }>;
    const options = Object.freeze({ linkedInboxAccountId: "row-1", inReplyTo: ORIGINAL_ID });
    const result = await naver.sendEmail("u1", "bob@example.com", "Hi", "b", attachments, options);
    expect(result).toHaveProperty("success", true);
  });
});

describe("sendEmail — who may be written to, and from where", () => {
  it.each([
    ["two recipients", "a@x.com, b@y.com"],
    ["a semicolon list", "a@x.com; b@y.com"],
    ["a bare domain", "accounts.google.com"],
    ["a no-reply address", "noreply@example.com"],
    ["an address with a trailing bracket", "bob@example.com>"],
    ["an address with a comment", "bob@example.com(x)evil.com"],
    ["an address with CRLF", "bob@example.com\r\nRCPT TO:<evil@example.com>"],
    ["a quoted local part", '"bob smith"@example.com'],
    ["a non-ASCII address", "bób@example.com"],
  ])("refuses %s before any connection", async (_name, to) => {
    const result = await naver.sendEmail("u1", to, "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    expect(result).toHaveProperty("error");
    expect(result).not.toHaveProperty("unsupported");
    expect(h.createTransport).not.toHaveBeenCalled();
    expect(h.imapCtorOpts).toHaveLength(0);
  });

  it("answers the Gmail sendEmail wording for the multiple-recipient guard", async () => {
    const result = await naver.sendEmail("u1", "a@x.com, b@y.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    expect(result).toEqual({
      error: "Send to one recipient at a time (no commas or semicolons in the address).",
    });
  });

  it("never lets a subject start another header", async () => {
    const result = await naver.sendEmail(
      "u1",
      "bob@example.com",
      "Hi\r\nBcc: evil@example.com",
      "b",
      [],
      { linkedInboxAccountId: "row-1" },
    );
    expect(result).toHaveProperty("success", true);
    const head = sentMime().split("\r\n\r\n")[0].split("\r\n");
    expect(head.some((line) => /^bcc:/i.test(line))).toBe(false);
    expect(h.sendMail.mock.calls[0][0].envelope.to).toEqual(["bob@example.com"]);
  });

  it("needs the linked mailbox id", async () => {
    expect(await naver.sendEmail("u1", "bob@example.com", "Hi", "b")).toEqual({
      error: "Naver actions need the linked mailbox id.",
    });
    expect(h.createTransport).not.toHaveBeenCalled();
  });

  it("looks the account up by id, user and provider, and refuses another user's row", async () => {
    h.findFirst.mockResolvedValue(null);
    const result = await naver.sendEmail("u2", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    expect(h.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "row-1", userId: "u2", provider: "NAVER" } }),
    );
    expect(result).toEqual({ error: "Naver mailbox is not connected." });
    expect(h.createTransport).not.toHaveBeenCalled();
  });

  it.each([
    ["an internal address", "169.254.169.254:993"],
    ["an arbitrary host", "evil.example.com:993"],
    ["the other provider's host", "imap.mail.me.com:993"],
    ["an smtp host in the imap field", "smtp.naver.com:587"],
  ])("refuses a NAVER row whose stored host is %s, before any connection", async (_name, imapHost) => {
    arm({ ...NAVER_ROW, imapHost });
    const result = await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    expect(result).toEqual({ error: "Naver mailbox is not connected." });
    expect(h.createTransport).not.toHaveBeenCalled();
    expect(h.imapCtorOpts).toHaveLength(0);
    expect(h.decryptToken).not.toHaveBeenCalled();
  });

  it("uses the registry SMTP host even when the stored IMAP host is spelled differently", async () => {
    arm({ ...NAVER_ROW, imapHost: "IMAP.NAVER.COM:993" });
    await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    expect(h.createTransport.mock.calls[0][0].host).toBe("smtp.naver.com");
  });

  it("refuses a row without credentials", async () => {
    arm({ ...NAVER_ROW, imapPasswordCipher: null });
    const result = await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    expect(result).toEqual({
      error: "Naver mailbox credentials are missing. Reconnect your Naver mailbox in Settings.",
    });
    expect(h.createTransport).not.toHaveBeenCalled();
  });

  it("refuses when the stored mailbox address is not a plain address, since it becomes From", async () => {
    arm({ ...NAVER_ROW, email: "me@naver.com>\r\nBcc: evil@example.com" });
    const result = await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    expect(result).toHaveProperty("error");
    expect(h.createTransport).not.toHaveBeenCalled();
  });

  it("reports an unreadable stored password as a reconnect hint", async () => {
    h.decryptToken.mockImplementation(() => {
      throw new Error("bad key");
    });
    const result = await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    expect(result).toEqual({ error: "Reconnect your Naver mailbox in Settings." });
    expect(h.createTransport).not.toHaveBeenCalled();
  });
});

describe("sendEmail — the Sent copy", () => {
  it("APPENDs the exact sent bytes to the \\Sent folder when the server did not store a copy", async () => {
    await naver.sendEmail("u1", "bob@example.com", "Hi", "Hello", [], {
      linkedInboxAccountId: "row-1",
    });
    await flush();
    const messageId = header(sentMime(), "Message-ID");
    expect(h.getMailboxLock).toHaveBeenCalledWith("Sent Messages");
    expect(h.search).toHaveBeenCalledWith({ header: { "message-id": messageId } }, { uid: true });
    expect(h.append).toHaveBeenCalledTimes(1);
    const [path, content, flags, date] = h.append.mock.calls[0];
    expect(path).toBe("Sent Messages");
    expect(Buffer.compare(content as Buffer, sentRaw())).toBe(0);
    expect(flags).toEqual(["\\Seen"]);
    expect(date).toBeInstanceOf(Date);
  });

  it("does not APPEND when the server already stored the message (no duplicate)", async () => {
    h.search.mockResolvedValue([42]);
    const result = await naver.sendEmail("u1", "bob@example.com", "Hi", "Hello", [], {
      linkedInboxAccountId: "row-1",
    });
    await flush();
    expect(result).toHaveProperty("success", true);
    expect(h.search).toHaveBeenCalledTimes(1);
    expect(h.append).not.toHaveBeenCalled();
  });

  it("ignores an approximate folder name and the INBOX when choosing the Sent folder", async () => {
    h.list.mockResolvedValue([
      FOLDERS[0],
      {
        path: "Sent Items",
        specialUse: "\\Sent",
        specialUseSource: "name-guess",
        flags: new Set(),
      },
    ]);
    const result = await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    await flush();
    expect(result).toHaveProperty("success", true);
    expect(h.append).not.toHaveBeenCalled();
    expect(loggedText()).toContain("no Sent folder");
  });

  it("never stores into a folder the server marks unselectable", async () => {
    h.list.mockResolvedValue([
      {
        path: "Sent Messages",
        specialUse: "\\Sent",
        specialUseSource: "extension",
        flags: new Set(["\\Noselect"]),
      },
      {
        path: "Old Sent",
        specialUse: "\\Sent",
        specialUseSource: "name",
        flags: new Set(["\\NonExistent"]),
      },
    ]);
    const result = await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    await flush();
    expect(result).toHaveProperty("success", true);
    expect(h.append).not.toHaveBeenCalled();
  });

  it("does not fail the send when the copy cannot be stored, and logs no address or password", async () => {
    h.append.mockRejectedValue(new Error(`NO [OVERQUOTA] me@naver.com ${PASSWORD}`));
    const result = await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    await flush();
    expect(result).toHaveProperty("success", true);
    expect(loggedText()).toContain("row-1");
    expect(loggedText()).not.toContain(PASSWORD);
    expect(loggedText()).not.toContain("me@naver.com");
  });

  it("does not open the IMAP connection when SMTP failed (no copy of a message that never left)", async () => {
    h.sendMail.mockRejectedValue(Object.assign(new Error("x"), { code: "ECONNECTION" }));
    await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    await flush();
    expect(h.imapCtorOpts).toHaveLength(0);
    expect(h.append).not.toHaveBeenCalled();
  });

  it("uses the explicit IMAP action timeouts and ends the session", async () => {
    await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    await flush();
    expect(h.imapCtorOpts[0]).toMatchObject({
      host: "imap.naver.com",
      connectionTimeout: IMAP_ACTION_CONNECT_TIMEOUT_MS,
      greetingTimeout: IMAP_ACTION_GREETING_TIMEOUT_MS,
      socketTimeout: IMAP_ACTION_SOCKET_TIMEOUT_MS,
    });
    expect(h.logout).toHaveBeenCalledTimes(1);
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it("iCloud: finds its own Sent folder", async () => {
    arm(ICLOUD_ROW);
    await icloud.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-2",
    });
    await flush();
    expect(h.imapCtorOpts[0]).toMatchObject({ host: "imap.mail.me.com" });
    expect(h.append.mock.calls[0][0]).toBe("Sent Messages");
  });
});

describe("sendEmail — failures", () => {
  it("a rejected login answers a reconnect error, without leaking the server text", async () => {
    h.sendMail.mockRejectedValue(authRejected());
    const result = await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    expect(result).toEqual({
      error: "Naver rejected the saved app password. Reconnect your Naver mailbox in Settings.",
    });
    expect(loggedText()).not.toContain(PASSWORD);
  });

  it("after a rejected login, later sends for that credential do not connect (cooldown)", async () => {
    h.sendMail.mockRejectedValueOnce(authRejected());
    await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    h.createTransport.mockClear();
    const again = await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    expect(again).toEqual({
      error: "Naver rejected the saved app password. Reconnect your Naver mailbox in Settings.",
    });
    expect(h.createTransport).not.toHaveBeenCalled();
  });

  it("the cooldown is shared with the B1 flag actions: a rejected SMTP login stops read/star too", async () => {
    h.sendMail.mockRejectedValueOnce(authRejected());
    await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    h.connect.mockClear();
    const flags = imapMailActions("NAVER");
    const result = await flags.toggleRead("u1", NAVER_MSG, true, "row-1");
    expect(result).toEqual({
      error: "Naver rejected the saved app password. Reconnect your Naver mailbox in Settings.",
    });
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("and the other way: a rejected IMAP login from a flag action stops sends, drafts and reply headers", async () => {
    h.connect.mockRejectedValueOnce(imapAuthRejected());
    const flags = imapMailActions("NAVER");
    await flags.toggleRead("u1", NAVER_MSG, true, "row-1");
    h.connect.mockClear();

    const sent = await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    const drafted = await naver.createDraft("u1", { ...draftInput, linkedInboxAccountId: "row-1" });
    const headers = await naver.getReplyHeaders("u1", NAVER_MSG, "row-1");
    expect(sent).toHaveProperty("error");
    expect(drafted).toHaveProperty("error");
    expect(headers).toEqual({});
    expect(h.createTransport).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("a reconnect (new cipher) ends the cooldown", async () => {
    h.sendMail.mockRejectedValueOnce(authRejected());
    await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    arm({ ...NAVER_ROW, imapPasswordCipher: "v2:new:cipher" });
    const result = await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    expect(result).toHaveProperty("success", true);
  });

  it("a transport failure answers { error } and does not start a cooldown", async () => {
    h.sendMail.mockRejectedValueOnce(
      Object.assign(new Error(`connect ETIMEDOUT ${PASSWORD}`), { code: "ETIMEDOUT" }),
    );
    const result = await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    expect(result).toEqual({ error: "Could not reach Naver. Try again shortly." });
    expect(loggedText()).not.toContain(PASSWORD);
    const retry = await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    expect(retry).toHaveProperty("success", true);
  });

  it("reports a transport failure to Sentry at most once per account per interval", async () => {
    h.sendMail.mockRejectedValue(Object.assign(new Error("boom"), { code: "ECONNECTION" }));
    for (let i = 0; i < 3; i++) {
      await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
        linkedInboxAccountId: "row-1",
      });
    }
    expect(h.captureError).toHaveBeenCalledTimes(1);
  });

  it("a rejected recipient answers a specific error and does not start a cooldown", async () => {
    h.sendMail.mockRejectedValueOnce(
      Object.assign(
        new Error("Can't send mail - all recipients were rejected: 550 bob@example.com"),
        {
          code: "EENVELOPE",
          responseCode: 550,
        },
      ),
    );
    const result = await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    expect(result).toEqual({ error: "Naver rejected the recipient address." });
    expect(loggedText()).not.toContain("bob@example.com");
    const retry = await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    expect(retry).toHaveProperty("success", true);
  });

  it("a refused message answers { error } and is not reported as a transport problem", async () => {
    h.sendMail.mockRejectedValueOnce(
      Object.assign(new Error("Message failed: 554 spam"), { code: "EMESSAGE", responseCode: 554 }),
    );
    const result = await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    expect(result).toEqual({ error: "Naver refused the message." });
  });

  it("never throws, even when building the transport fails", async () => {
    h.createTransport.mockImplementation(() => {
      throw new Error("invalid config");
    });
    const result = await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    expect(result).toEqual({ error: "Could not reach Naver. Try again shortly." });
  });

  it("never throws when the account lookup fails, and logs no message id", async () => {
    h.findFirst.mockRejectedValue(
      Object.assign(new Error(`db down ${NAVER_MSG}`), {
        name: "PrismaClientKnownRequestError",
        code: "P1001",
      }),
    );
    const result = await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    expect(result).toEqual({ error: "Could not look up your Naver mailbox. Try again shortly." });
    expect(loggedText()).not.toContain(NAVER_MSG);
  });
});

describe("sendEmail — concurrency", () => {
  it("serializes sends of one account: the second waits for the first", async () => {
    let releaseFirst: () => void = () => {};
    h.sendMail.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve({ accepted: ["x"], rejected: [] });
        }),
    );
    const first = naver.sendEmail("u1", "bob@example.com", "1", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    const second = naver.sendEmail("u1", "bob@example.com", "2", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    await flush();
    expect(h.createTransport).toHaveBeenCalledTimes(1);
    releaseFirst();
    expect(await first).toHaveProperty("success", true);
    expect(await second).toHaveProperty("success", true);
    expect(h.createTransport).toHaveBeenCalledTimes(2);
  });

  it("caps concurrent sessions across accounts at the shared B1 limit", async () => {
    const rows = Object.fromEntries(
      [1, 2, 3, 4, 5].map((n) => [
        `row-${n}`,
        { ...NAVER_ROW, id: `row-${n}`, email: `u${n}@naver.com` },
      ]),
    );
    h.findFirst.mockImplementation(
      async ({ where }: { where: { id: string } }) => rows[where.id] ?? null,
    );
    const pending: Array<() => void> = [];
    let inFlight = 0;
    let peak = 0;
    h.sendMail.mockImplementation(
      () =>
        new Promise((resolve) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          pending.push(() => {
            inFlight -= 1;
            resolve({ accepted: ["x"], rejected: [] });
          });
        }),
    );
    const results = [1, 2, 3, 4, 5].map((n) =>
      naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], { linkedInboxAccountId: `row-${n}` }),
    );
    await flush();
    expect(inFlight).toBe(MAX_CONCURRENT_IMAP_ACTION_SESSIONS);
    while (pending.length > 0) {
      pending.shift()?.();
      await flush();
    }
    for (const result of await Promise.all(results)) expect(result).toHaveProperty("success", true);
    expect(peak).toBe(MAX_CONCURRENT_IMAP_ACTION_SESSIONS);
  });
});

describe("createDraft", () => {
  it("APPENDs to the \\Drafts folder with the \\Draft flag and returns a draft id and link", async () => {
    const result = await naver.createDraft("u1", { ...draftInput, linkedInboxAccountId: "row-1" });
    expect(h.append).toHaveBeenCalledTimes(1);
    const [path, content, flags] = h.append.mock.calls[0];
    expect(path).toBe("Drafts");
    expect(flags).toContain("\\Draft");
    const mime = (content as Buffer).toString("utf-8");
    const messageId = header(mime, "Message-ID");
    expect(header(mime, "From")).toBe("me@naver.com");
    expect(header(mime, "To")).toBe("bob@example.com");
    expect(result).toEqual({
      success: true,
      draftId: messageId,
      messageId,
      url: "https://mail.naver.com/",
    });
    expect(h.createTransport).not.toHaveBeenCalled();
  });

  it("honours the reply context", async () => {
    await naver.createDraft("u1", {
      ...draftInput,
      linkedInboxAccountId: "row-1",
      reply: { inReplyTo: ORIGINAL_ID, references: `<root@x.example> ${ORIGINAL_ID}` },
    });
    const mime = (h.append.mock.calls[0][1] as Buffer).toString("utf-8");
    expect(header(mime, "In-Reply-To")).toBe(ORIGINAL_ID);
    expect(header(mime, "References")).toBe(`<root@x.example> ${ORIGINAL_ID}`);
  });

  it("writes no threading headers without a reply context", async () => {
    await naver.createDraft("u1", { ...draftInput, linkedInboxAccountId: "row-1" });
    const mime = (h.append.mock.calls[0][1] as Buffer).toString("utf-8");
    expect(header(mime, "In-Reply-To")).toBeUndefined();
  });

  it("attaches files through the shared builder", async () => {
    await naver.createDraft("u1", {
      ...draftInput,
      linkedInboxAccountId: "row-1",
      attachments: [{ filename: "a.txt", mimeType: "text/plain", content: Buffer.from("hello") }],
    });
    expect((h.append.mock.calls[0][1] as Buffer).toString("utf-8")).toContain("multipart/mixed");
  });

  it("answers { error } when the mailbox has no Drafts folder", async () => {
    h.list.mockResolvedValue([FOLDERS[0]]);
    const result = await naver.createDraft("u1", { ...draftInput, linkedInboxAccountId: "row-1" });
    expect(result).toEqual({ error: "Could not find the Drafts folder in your Naver mailbox." });
    expect(h.append).not.toHaveBeenCalled();
  });

  it("answers { error } when the server refuses the APPEND", async () => {
    h.append.mockResolvedValue(false);
    const result = await naver.createDraft("u1", { ...draftInput, linkedInboxAccountId: "row-1" });
    expect(result).toEqual({ error: "Naver did not save the draft." });
  });

  it("answers { error } on a transport failure and never throws", async () => {
    h.connect.mockRejectedValue(new Error("ECONNRESET"));
    const result = await naver.createDraft("u1", { ...draftInput, linkedInboxAccountId: "row-1" });
    expect(result).toEqual({ error: "Could not reach Naver. Try again shortly." });
  });

  it("refuses an invalid or no-reply recipient and a tampered host before connecting", async () => {
    expect(
      await naver.createDraft("u1", { ...draftInput, to: "nope", linkedInboxAccountId: "row-1" }),
    ).toHaveProperty("error");
    expect(
      await naver.createDraft("u1", {
        ...draftInput,
        to: "noreply@example.com",
        linkedInboxAccountId: "row-1",
      }),
    ).toHaveProperty("error");
    arm({ ...NAVER_ROW, imapHost: "169.254.169.254:993" });
    expect(await naver.createDraft("u1", { ...draftInput, linkedInboxAccountId: "row-1" })).toEqual(
      {
        error: "Naver mailbox is not connected.",
      },
    );
    expect(h.imapCtorOpts).toHaveLength(0);
  });

  it("needs the linked mailbox id, and threads it to the account lookup", async () => {
    expect(await naver.createDraft("u1", draftInput)).toEqual({
      error: "Naver actions need the linked mailbox id.",
    });
    await naver.createDraft("u1", { ...draftInput, linkedInboxAccountId: "row-1" });
    expect(h.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "row-1", userId: "u1", provider: "NAVER" } }),
    );
  });

  it("iCloud: drafts go to its own webmail link", async () => {
    arm(ICLOUD_ROW);
    const result = await icloud.createDraft("u1", { ...draftInput, linkedInboxAccountId: "row-2" });
    expect(result).toMatchObject({ success: true, url: "https://www.icloud.com/mail/" });
  });
});

describe("getReplyHeaders", () => {
  it("fetches Message-ID and References of the original by UID and returns parsed ids", async () => {
    const result = await naver.getReplyHeaders("u1", NAVER_MSG, "row-1");
    expect(h.getMailboxLock).toHaveBeenCalledWith("INBOX");
    expect(h.fetchOne).toHaveBeenCalledWith(
      "101",
      { headers: ["message-id", "references"] },
      { uid: true },
    );
    expect(result).toEqual({
      messageId: ORIGINAL_ID,
      references: "<root@x.example> <mid@x.example>",
    });
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.logout).toHaveBeenCalledTimes(1);
  });

  it("drops everything that is not a message id", async () => {
    h.fetchOne.mockResolvedValue({
      uid: 101,
      headers: Buffer.from(
        `Message-ID: evil\u2028text ${ORIGINAL_ID}\r\nReferences: not an id at all\r\n\r\n`,
      ),
    });
    const result = await naver.getReplyHeaders("u1", NAVER_MSG, "row-1");
    expect(result).toEqual({ messageId: ORIGINAL_ID });
    expect(JSON.stringify(result)).not.toContain("evil");
  });

  it.each([
    ["another mailbox", "naver-imap:other@naver.com:101"],
    ["another provider", "icloud-imap:me@naver.com:101"],
    ["a range", "naver-imap:me@naver.com:1:5"],
    ["a padded uid", "naver-imap:me@naver.com:0101"],
    ["a gmail id", "18c2f0a9d3b4e5f6"],
    ["a non-string", 101 as unknown as string],
  ])("answers {} for %s without opening a connection", async (_name, id) => {
    expect(await naver.getReplyHeaders("u1", id, "row-1")).toEqual({});
    expect(h.imapCtorOpts).toHaveLength(0);
  });

  it("answers {} when the message is gone, on any failure, and without a linked id", async () => {
    h.fetchOne.mockResolvedValueOnce(false);
    expect(await naver.getReplyHeaders("u1", NAVER_MSG, "row-1")).toEqual({});
    h.connect.mockRejectedValueOnce(new Error("ECONNRESET"));
    expect(await naver.getReplyHeaders("u1", NAVER_MSG, "row-1")).toEqual({});
    expect(await naver.getReplyHeaders("u1", NAVER_MSG, null)).toEqual({});
    expect(await naver.getReplyHeaders("u1", NAVER_MSG)).toEqual({});
  });

  it("answers {} for a tampered host without connecting", async () => {
    arm({ ...NAVER_ROW, imapHost: "evil.example.com:993" });
    expect(await naver.getReplyHeaders("u1", NAVER_MSG, "row-1")).toEqual({});
    expect(h.imapCtorOpts).toHaveLength(0);
  });

  it("never logs the full message id or the password", async () => {
    h.connect.mockRejectedValueOnce(new Error(`boom ${NAVER_MSG} ${PASSWORD}`));
    await naver.getReplyHeaders("u1", NAVER_MSG, "row-1");
    expect(loggedText()).not.toContain(NAVER_MSG);
    expect(loggedText()).not.toContain(PASSWORD);
  });
});

describe("logging", () => {
  it("a full send, draft and reply-header round trip logs no credential and no full message id", async () => {
    await naver.getReplyHeaders("u1", NAVER_MSG, "row-1");
    await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
      inReplyTo: ORIGINAL_ID,
    });
    await naver.createDraft("u1", { ...draftInput, linkedInboxAccountId: "row-1" });
    await flush();
    const text = loggedText();
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(CIPHER);
    expect(text).not.toContain(NAVER_MSG);
  });
});
