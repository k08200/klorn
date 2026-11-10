/**
 * A send whose nodemailer import fails (a broken install, a missing package) says
 * so: sending is unavailable and NOTHING was sent. It must not claim the mailbox
 * could not be reached, which is a different problem with a different remedy, and
 * it must not leak the error text (an import error names a filesystem path).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { arm, h, loggedText, resetHarness, settle } from "./helpers/imap-send-harness.js";

vi.mock("nodemailer", () => {
  throw new Error("Cannot find package 'nodemailer' imported from /srv/klorn/secret/path.js");
});
vi.mock("imapflow", async () => ({
  ImapFlow: (await import("./helpers/imap-send-harness.js")).FakeImapFlow,
}));
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

beforeEach(() => {
  resetHarness();
  resetImapSessionState();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  arm();
});
afterEach(() => vi.restoreAllMocks());

describe("nodemailer cannot be imported", () => {
  it("answers 'sending is unavailable, not sent', not 'could not reach'", async () => {
    const result = await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    expect(result).toEqual({
      error:
        "Sending through Naver is temporarily unavailable. The message was not sent; try again later.",
    });
    expect(JSON.stringify(result)).not.toContain("Could not reach");
  });

  it("opens no IMAP connection, files no copy, starts no cooldown", async () => {
    await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    await settle();
    expect(h.imapCtorOpts).toHaveLength(0);
    const again = await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    expect(again).toHaveProperty("error");
    expect(again).not.toHaveProperty("unsupported");
  });

  it("is logged and reported without the import error's text or path", async () => {
    await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
      linkedInboxAccountId: "row-1",
    });
    expect(h.captureError).toHaveBeenCalledTimes(1);
    expect(loggedText()).not.toContain("/srv/klorn/secret");
    const reported = h.captureError.mock.calls[0][0] as Error;
    expect(reported.message).not.toContain("/srv/klorn/secret");
  });

  it("drafts are unaffected: they never import nodemailer", async () => {
    const result = await naver.createDraft("u1", {
      to: "bob@example.com",
      subject: "s",
      body: "b",
      linkedInboxAccountId: "row-1",
    });
    expect(result).toHaveProperty("success", true);
  });
});
