/**
 * Step B3: which folder a Sent copy or a draft may be written to.
 *
 * imapflow reports a folder's role either from the server's SPECIAL-USE flag
 * (`specialUseSource: "extension"`) or from its NAME (`"name"`). imapflow 1.7.0
 * folds its looser "name-guess" tier into "name" before reporting it
 * (lib/commands/list.js: PUBLIC_SOURCE), so "name" alone does not mean the name
 * was an exact match. A server-flagged folder is trusted; a name-sourced one is
 * trusted only when its leaf name is exactly Sent, Sent Messages or Drafts
 * (case-insensitive). Anything else, and any role with no source, is NOT written
 * to: a mail in the wrong folder is worse than no copy. Fixtures have the shape
 * `list()` returns (see helpers/imap-send-harness.ts `folder`).
 *
 * Why no Korean names: Naver's help pages document the web folders (for example
 * "임시보관함", https://help.naver.com/service/30029/contents/21155) but nowhere
 * say what IMAP LIST reports, so they are not in the set. Whether Naver sends
 * SPECIAL-USE flags is checked before the flip.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  arm,
  draftInput,
  folder,
  h,
  loggedText,
  resetHarness,
  settle,
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

beforeEach(() => {
  resetHarness();
  resetImapSessionState();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  arm();
});
afterEach(() => vi.restoreAllMocks());

type Role = { specialUse: string; specialUseSource: "user" | "extension" | "name" };
const sent = (source: Role["specialUseSource"]): Role => ({
  specialUse: "\\Sent",
  specialUseSource: source,
});
const drafts = (source: Role["specialUseSource"]): Role => ({
  specialUse: "\\Drafts",
  specialUseSource: source,
});

async function sendAndSettle() {
  const result = await naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], {
    linkedInboxAccountId: "row-1",
  });
  await settle();
  return result;
}

describe("Sent folder", () => {
  it("uses a server-flagged folder whatever it is called", async () => {
    h.list.mockResolvedValue([folder("INBOX"), folder("Verzonden items", sent("extension"))]);
    await sendAndSettle();
    expect(h.append.mock.calls[0][0]).toBe("Verzonden items");
  });

  it.each([
    ["Sent"],
    ["sent"],
    ["SENT"],
    ["Sent Messages"],
    ["sent messages"],
  ])("uses a name-sourced folder called %s", async (name) => {
    h.list.mockResolvedValue([folder("INBOX"), folder(name, sent("name"))]);
    await sendAndSettle();
    expect(h.append.mock.calls[0][0]).toBe(name);
  });

  it("matches on the leaf of a nested path", async () => {
    h.list.mockResolvedValue([folder("INBOX.Sent", sent("name"), [], ".")]);
    await sendAndSettle();
    expect(h.append.mock.calls[0][0]).toBe("INBOX.Sent");
  });

  it.each([
    ["Sent Items"],
    ["Sent Mail"],
    ["Sent Stuff"],
    ["My Sent"],
    ["Sent Backup 2019"],
    ["보낸편지함"],
    ["보낸메일함"],
    ["Gesendet"],
    ["Sent/Archive"],
  ])("does NOT write to a name-sourced folder called %s (a guess, or unknown)", async (name) => {
    h.list.mockResolvedValue([folder("INBOX"), folder(name, sent("name"))]);
    const result = await sendAndSettle();
    expect(result).toHaveProperty("success", true);
    expect(h.append).not.toHaveBeenCalled();
    expect(loggedText()).toContain("no Sent folder");
  });

  it("does not write when the role has no source at all", async () => {
    h.list.mockResolvedValue([{ ...folder("Sent Messages"), specialUse: "\\Sent" }]);
    await sendAndSettle();
    expect(h.append).not.toHaveBeenCalled();
  });

  it.each([
    ["\\Noselect"],
    ["\\NonExistent"],
  ])("never writes to a folder flagged %s", async (flag) => {
    h.list.mockResolvedValue([folder("Sent Messages", sent("extension"), [flag])]);
    await sendAndSettle();
    expect(h.append).not.toHaveBeenCalled();
  });

  it("does not take another role's folder for Sent", async () => {
    h.list.mockResolvedValue([folder("Drafts", drafts("extension")), folder("INBOX")]);
    await sendAndSettle();
    expect(h.append).not.toHaveBeenCalled();
  });

  it("skipping the copy never fails the send", async () => {
    h.list.mockResolvedValue([folder("Sent Items", sent("name"))]);
    expect(await sendAndSettle()).toHaveProperty("success", true);
  });
});

describe("Drafts folder", () => {
  const draft = () => naver.createDraft("u1", { ...draftInput, linkedInboxAccountId: "row-1" });

  it("uses a server-flagged folder whatever it is called", async () => {
    h.list.mockResolvedValue([folder("Entwürfe", drafts("extension"))]);
    expect(await draft()).toHaveProperty("success", true);
    expect(h.append.mock.calls[0][0]).toBe("Entwürfe");
  });

  it.each([
    ["Drafts"],
    ["drafts"],
    ["DRAFTS"],
  ])("uses a name-sourced folder called %s", async (name) => {
    h.list.mockResolvedValue([folder(name, drafts("name"))]);
    expect(await draft()).toHaveProperty("success", true);
    expect(h.append.mock.calls[0][0]).toBe(name);
  });

  it.each([
    ["Draft"],
    ["Drafts Backup"],
    ["My Drafts"],
    ["임시보관함"],
    ["Entwürfe"],
    ["Drafts/Old"],
  ])("does NOT write a draft into a name-sourced folder called %s", async (name) => {
    h.list.mockResolvedValue([folder(name, drafts("name"))]);
    expect(await draft()).toEqual({
      error: "Could not find the Drafts folder in your Naver mailbox.",
    });
    expect(h.append).not.toHaveBeenCalled();
  });

  it("does not use a Sent folder for a draft", async () => {
    h.list.mockResolvedValue([folder("Sent Messages", sent("extension"))]);
    expect(await draft()).toHaveProperty("error");
    expect(h.append).not.toHaveBeenCalled();
  });
});
