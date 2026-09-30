/**
 * Step B3 of docs/providers/unified-platform-plan.md: drafts and reply headers for
 * NAVER and ICLOUD over IMAP. Drafts APPEND to the \\Drafts folder with both
 * `\\Draft` and `\\Seen`, honour the reply context and never touch SMTP; reply
 * headers are fetched by a strictly parsed UID and only parsed message ids leave.
 * Fakes as in imap-send-actions.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  arm,
  CIPHER,
  draftInput,
  FOLDERS,
  flush,
  h,
  header,
  ICLOUD_ROW,
  loggedText,
  NAVER_MSG,
  NAVER_ROW,
  ORIGINAL_ID,
  PASSWORD,
  resetHarness,
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
const { resetImapSessionState } = await import("../mail/providers/imap-session.js");

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

describe("createDraft", () => {
  it("APPENDs to the \\Drafts folder with the \\Draft flag and returns a draft id and link", async () => {
    const result = await naver.createDraft("u1", { ...draftInput, linkedInboxAccountId: "row-1" });
    expect(h.append).toHaveBeenCalledTimes(1);
    const [path, content, flags] = h.append.mock.calls[0];
    expect(path).toBe("Drafts");
    // both flags: \\Draft marks it a draft, \\Seen keeps it out of the unread count
    expect(flags).toEqual(["\\Draft", "\\Seen"]);
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

  it("answers the same specific message as a send for an address SMTP could not carry", async () => {
    const sendResult = await naver.sendEmail("u1", "bób@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    const draftResult = await naver.createDraft("u1", {
      ...draftInput,
      to: "bób@example.com",
      linkedInboxAccountId: "row-1",
    });
    expect(draftResult).toEqual(sendResult);
    expect(draftResult).toEqual({
      error: "Klorn can only use a plain address (letters, digits and . _ + - before the @).",
    });
    expect(h.imapCtorOpts).toHaveLength(0);
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
