/**
 * Step B3: which action surface a NAVER / ICLOUD mailbox gets, per flag.
 *
 * IMAP_SEND_ENABLED (send, drafts, reply headers over SMTP and IMAP) is
 * independent of IMAP_ACTIONS_ENABLED (read and star over IMAP flags). With it
 * OFF the send side is exactly what main had: every mutation answers
 * `unsupported`, `getReplyHeaders` answers `{}`, and no SMTP transport and no
 * IMAP client is ever constructed. ICLOUD additionally needs
 * ICLOUD_INBOX_ENABLED, the same composition as B1. Generic IMAP, OUTLOOK and
 * GOOGLE ignore the flag.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  findFirst: vi.fn(),
  createTransport: vi.fn(),
  imapCtor: vi.fn(),
}));

vi.mock("../db.js", () => {
  const prisma = { linkedInboxAccount: { findFirst: h.findFirst } };
  return { prisma, db: prisma };
});
vi.mock("../mail/gmail.js", () => ({
  sendEmail: vi.fn(),
  createEmailDraft: vi.fn(),
  getReplyHeaders: vi.fn(),
  markAsRead: vi.fn(),
  toggleReadGmail: vi.fn(),
  toggleStarGmail: vi.fn(),
  trashEmail: vi.fn(),
  untrashEmail: vi.fn(),
  archiveEmail: vi.fn(),
  unarchiveEmail: vi.fn(),
}));
vi.mock("nodemailer", () => ({ createTransport: h.createTransport }));
vi.mock("imapflow", () => ({
  ImapFlow: class {
    constructor(opts: unknown) {
      h.imapCtor(opts);
    }
  },
}));
vi.mock("../crypto-tokens.js", () => ({ decryptToken: () => "pw" }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const { mailActionsForProvider } = await import("../mail/providers/dispatch.js");
const { unsupportedMailActions } = await import("../mail/providers/unsupported.js");
const { imapSendEnabled } = await import("../config.js");

const FLAGS = ["IMAP_SEND_ENABLED", "IMAP_ACTIONS_ENABLED", "ICLOUD_INBOX_ENABLED"] as const;
const original = Object.fromEntries(FLAGS.map((name) => [name, process.env[name]]));

function setFlags(values: Partial<Record<(typeof FLAGS)[number], string>>) {
  for (const name of FLAGS) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

beforeEach(() => {
  setFlags({});
  vi.clearAllMocks();
});
afterEach(() => {
  for (const name of FLAGS) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** A draft with no linked id: a real implementation answers `{error}`, the stub `unsupported`. */
const draft = { to: "bob@example.com", subject: "s", body: "b" };

async function sendSurface(provider: "NAVER" | "ICLOUD" | "IMAP" | "OUTLOOK") {
  const actions = mailActionsForProvider(provider);
  return {
    send: await actions.sendEmail("u1", "bob@example.com", "s", "b"),
    draft: await actions.createDraft("u1", draft),
  };
}

describe("imapSendEnabled — request-time, lenient parse", () => {
  it.each(["true", "TRUE", " 1 ", "yes", "on", "On"])("%j is on", (value) => {
    process.env.IMAP_SEND_ENABLED = value;
    expect(imapSendEnabled()).toBe(true);
  });

  it.each(["", "0", "false", "no", "off", "enabled", "2"])("%j is off", (value) => {
    process.env.IMAP_SEND_ENABLED = value;
    expect(imapSendEnabled()).toBe(false);
  });

  it("is off when unset, and is read on every call", () => {
    expect(imapSendEnabled()).toBe(false);
    process.env.IMAP_SEND_ENABLED = "true";
    expect(imapSendEnabled()).toBe(true);
    process.env.IMAP_SEND_ENABLED = "false";
    expect(imapSendEnabled()).toBe(false);
  });
});

describe("flag OFF — byte-identical to main", () => {
  it.each([
    "NAVER",
    "ICLOUD",
  ] as const)("%s send side is the unsupported refusal", async (provider) => {
    setFlags({ ICLOUD_INBOX_ENABLED: "true" });
    const stub = unsupportedMailActions(provider);
    const actual = await sendSurface(provider);
    expect(actual.send).toEqual(await stub.sendEmail("u1", "bob@example.com", "s", "b"));
    expect(actual.draft).toEqual(await stub.createDraft("u1", draft));
    expect(actual.send).toEqual({
      unsupported: true,
      error: "This mailbox's provider does not support sending mail from Klorn yet.",
    });
    expect(await mailActionsForProvider(provider).getReplyHeaders("u1", "id", "row")).toEqual({});
  });

  it("returns the very same object on every call and constructs no client", () => {
    const first = mailActionsForProvider("NAVER");
    expect(mailActionsForProvider("NAVER")).toBe(first);
    expect(h.createTransport).not.toHaveBeenCalled();
    expect(h.imapCtor).not.toHaveBeenCalled();
  });

  it("IMAP_ACTIONS_ENABLED alone does not open the send side", async () => {
    setFlags({ IMAP_ACTIONS_ENABLED: "true" });
    const actions = mailActionsForProvider("NAVER");
    expect(await actions.sendEmail("u1", "bob@example.com", "s", "b")).toMatchObject({
      unsupported: true,
    });
    expect(await actions.createDraft("u1", draft)).toMatchObject({ unsupported: true });
  });
});

describe("IMAP_SEND_ENABLED on", () => {
  it("NAVER answers the real implementation (no linked id is a soft error, never unsupported)", async () => {
    setFlags({ IMAP_SEND_ENABLED: "true" });
    const { send, draft: created } = await sendSurface("NAVER");
    expect(send).toEqual({ error: "Naver actions need the linked mailbox id." });
    expect(created).toEqual({ error: "Naver actions need the linked mailbox id." });
    expect(h.createTransport).not.toHaveBeenCalled();
  });

  it("read and star stay unsupported while IMAP_ACTIONS_ENABLED is off", async () => {
    setFlags({ IMAP_SEND_ENABLED: "true" });
    const actions = mailActionsForProvider("NAVER");
    expect(await actions.markAsRead("u1", "id", "row")).toMatchObject({ unsupported: true });
    expect(await actions.toggleStar("u1", "id", true, "row")).toMatchObject({ unsupported: true });
    expect(await actions.trash("u1", "id", "row")).toMatchObject({ unsupported: true });
    expect(await actions.archive("u1", "id", "row")).toMatchObject({ unsupported: true });
  });

  it("with both flags on, send and read/star are both real; trash and archive stay unsupported", async () => {
    setFlags({ IMAP_SEND_ENABLED: "true", IMAP_ACTIONS_ENABLED: "true" });
    const actions = mailActionsForProvider("NAVER");
    expect(await actions.sendEmail("u1", "bob@example.com", "s", "b")).toHaveProperty("error");
    expect(await actions.markAsRead("u1", "id", null)).toEqual({
      error: "Naver actions need the linked mailbox id.",
    });
    expect(await actions.trash("u1", "id", "row")).toMatchObject({ unsupported: true });
    expect(await actions.unarchive("u1", "id", "row")).toMatchObject({ unsupported: true });
    expect(actions.provider).toBe("NAVER");
  });

  it("ICLOUD stays unsupported until ICLOUD_INBOX_ENABLED is on too", async () => {
    setFlags({ IMAP_SEND_ENABLED: "true" });
    const closed = await sendSurface("ICLOUD");
    expect(closed.send).toMatchObject({ unsupported: true });
    expect(closed.draft).toMatchObject({ unsupported: true });

    setFlags({ IMAP_SEND_ENABLED: "true", ICLOUD_INBOX_ENABLED: "true" });
    const open = await sendSurface("ICLOUD");
    expect(open.send).toEqual({ error: "iCloud actions need the linked mailbox id." });
    expect(open.draft).toEqual({ error: "iCloud actions need the linked mailbox id." });
  });

  it("generic IMAP and OUTLOOK ignore the flag", async () => {
    setFlags({
      IMAP_SEND_ENABLED: "true",
      IMAP_ACTIONS_ENABLED: "true",
      ICLOUD_INBOX_ENABLED: "true",
    });
    const imap = await sendSurface("IMAP");
    expect(imap.send).toMatchObject({ unsupported: true });
    expect(imap.draft).toMatchObject({ unsupported: true });
    expect(mailActionsForProvider("IMAP").provider).toBe("IMAP");
    expect(mailActionsForProvider("OUTLOOK").provider).toBe("OUTLOOK");
    expect(mailActionsForProvider("GOOGLE").provider).toBe("GOOGLE");
  });

  it("flipping the flag needs no restart", async () => {
    expect((await sendSurface("NAVER")).send).toMatchObject({ unsupported: true });
    setFlags({ IMAP_SEND_ENABLED: "true" });
    expect((await sendSurface("NAVER")).send).not.toHaveProperty("unsupported");
    setFlags({});
    expect((await sendSurface("NAVER")).send).toMatchObject({ unsupported: true });
  });
});
