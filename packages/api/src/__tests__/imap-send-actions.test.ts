/**
 * Step B3 of docs/providers/unified-platform-plan.md: sending over SMTP for NAVER
 * and ICLOUD.
 *
 * nodemailer's transport and the imapflow client are faked (there is no public
 * Naver or iCloud sandbox; the real library is exercised against a local socket
 * in smtp-wire.test.ts). These pin: the SMTP endpoint and TLS options come from
 * the registry only, a row with a tampered host is refused before any
 * connection, the recipient guard, the MIME and envelope handed to SMTP (From is
 * the linked account, reply threading headers present), the Sent copy (APPENDed
 * only when the server did not already store it), the auth cooldown shared with
 * the B1 flag actions in both directions, transport failures as `{ error }`,
 * per-account serialization and the global cap, and that neither a credential
 * nor a full `<prefix>:<email>:<uid>` reaches a log. Drafts and reply headers are
 * in imap-send-drafts.test.ts, deadlines in imap-send-deadlines.test.ts, folder
 * choice in imap-send-folders.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  arm,
  authRejected,
  CIPHER,
  draftInput,
  flush,
  h,
  header,
  ICLOUD_ROW,
  imapAuthRejected,
  loggedText,
  NAVER_MSG,
  NAVER_ROW,
  ORIGINAL_ID,
  PASSWORD,
  resetHarness,
  sentMime,
  sentRaw,
} from "./helpers/imap-send-harness.js";

vi.mock("imapflow", async () => ({
  ImapFlow: (await import("./helpers/imap-send-harness.js")).FakeImapFlow,
}));
vi.mock("nodemailer", async () => {
  const { h } = await import("./helpers/imap-send-harness.js");
  h.nodemailerLoads += 1;
  return { createTransport: (...args: unknown[]) => h.createTransport(...args) };
});
vi.mock("../db.js", async () => {
  const { h } = await import("./helpers/imap-send-harness.js");
  const prisma = {
    linkedInboxAccount: { findFirst: (...args: unknown[]) => h.findFirst(...args) },
    emailMessage: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  return { prisma, db: prisma };
});
vi.mock("../crypto-tokens.js", async () => {
  const { h } = await import("./helpers/imap-send-harness.js");
  return { decryptToken: (...args: unknown[]) => h.decryptToken(...args) };
});
vi.mock("../sentry.js", async () => {
  const { h } = await import("./helpers/imap-send-harness.js");
  return { captureError: (...args: unknown[]) => h.captureError(...args) };
});

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

const naver = imapSendActions("NAVER");
const icloud = imapSendActions("ICLOUD");

beforeEach(() => {
  resetHarness();
  resetImapSessionState();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  arm();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

  it("a refused sender (MAIL FROM) is reported as such, not as a recipient problem", async () => {
    h.sendMail.mockRejectedValueOnce(
      Object.assign(new Error("Mail command failed: 553 5.7.1 sender not owned by user"), {
        code: "EENVELOPE",
        responseCode: 553,
        command: "MAIL FROM",
      }),
    );
    const result = await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    expect(result).toEqual({ error: "Naver did not accept the sending address." });
    expect(result).not.toEqual({ error: "Naver rejected the recipient address." });
    expect(loggedText()).toContain("command=MAIL FROM");
    // not a rejected password: no cooldown, the next send connects
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
    // nodemailer is imported lazily, so each send needs a few ticks to reach sendMail
    await vi.waitFor(() => expect(inFlight).toBe(MAX_CONCURRENT_IMAP_ACTION_SESSIONS));
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
