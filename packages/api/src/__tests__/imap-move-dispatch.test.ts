/**
 * Step B2: which action surface a NAVER / ICLOUD mailbox gets, per flag.
 *
 * IMAP_MOVE_ACTIONS_ENABLED (archive, trash and their undo over IMAP MOVE) is
 * independent of IMAP_ACTIONS_ENABLED (read and star) and IMAP_SEND_ENABLED (send,
 * drafts, reply headers). With it OFF the move side is exactly what main had: the
 * four actions answer `unsupported` (501 at the routes), and no IMAP client is ever
 * constructed. ICLOUD additionally needs ICLOUD_INBOX_ENABLED. Generic IMAP,
 * OUTLOOK and GOOGLE ignore the flag.
 *
 * A real implementation answers `{ error }` for a call with no linked mailbox id;
 * the stub answers `unsupported`. That difference is how these tests tell them apart
 * without a server.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  findFirst: vi.fn(),
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
const { imapMoveActionsEnabled } = await import("../config.js");

const FLAGS = [
  "IMAP_MOVE_ACTIONS_ENABLED",
  "IMAP_ACTIONS_ENABLED",
  "IMAP_SEND_ENABLED",
  "ICLOUD_INBOX_ENABLED",
] as const;
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

const MOVE_ACTIONS = ["trash", "untrash", "archive", "unarchive"] as const;

/** The four move actions of a provider, called with no linked mailbox id. */
async function moveSurface(provider: "NAVER" | "ICLOUD" | "IMAP" | "OUTLOOK") {
  const actions = mailActionsForProvider(provider);
  return {
    trash: await actions.trash("u1", "id", null),
    untrash: await actions.untrash("u1", "id", null),
    archive: await actions.archive("u1", "id", null),
    unarchive: await actions.unarchive("u1", "id", null),
  };
}

describe("imapMoveActionsEnabled — request-time, lenient parse", () => {
  it.each(["true", "TRUE", " 1 ", "yes", "on", "On"])("%j is on", (value) => {
    process.env.IMAP_MOVE_ACTIONS_ENABLED = value;
    expect(imapMoveActionsEnabled()).toBe(true);
  });

  it.each(["", "0", "false", "no", "off", "enabled", "2"])("%j is off", (value) => {
    process.env.IMAP_MOVE_ACTIONS_ENABLED = value;
    expect(imapMoveActionsEnabled()).toBe(false);
  });

  it("is off when unset, and is read on every call", () => {
    expect(imapMoveActionsEnabled()).toBe(false);
    process.env.IMAP_MOVE_ACTIONS_ENABLED = "true";
    expect(imapMoveActionsEnabled()).toBe(true);
    process.env.IMAP_MOVE_ACTIONS_ENABLED = "false";
    expect(imapMoveActionsEnabled()).toBe(false);
  });
});

describe("flag OFF — byte-identical to main", () => {
  it.each([
    "NAVER",
    "ICLOUD",
  ] as const)("%s move side is the unsupported refusal", async (provider) => {
    setFlags({ ICLOUD_INBOX_ENABLED: "true" });
    const stub = unsupportedMailActions(provider);

    const actual = await moveSurface(provider);

    expect(actual.trash).toEqual(await stub.trash("u1", "id", null));
    expect(actual.untrash).toEqual(await stub.untrash("u1", "id", null));
    expect(actual.archive).toEqual(await stub.archive("u1", "id", null));
    expect(actual.unarchive).toEqual(await stub.unarchive("u1", "id", null));
    expect(actual.trash).toEqual({
      unsupported: true,
      error: "This mailbox's provider does not support delete from Klorn yet.",
    });
    expect(actual.archive).toEqual({
      unsupported: true,
      error: "This mailbox's provider does not support archive from Klorn yet.",
    });
  });

  it("returns the very same object on every call and constructs no client", () => {
    const first = mailActionsForProvider("NAVER");
    expect(mailActionsForProvider("NAVER")).toBe(first);
    expect(h.imapCtor).not.toHaveBeenCalled();
  });

  it("the other two flags alone do not open the move side", async () => {
    setFlags({ IMAP_ACTIONS_ENABLED: "true", IMAP_SEND_ENABLED: "true" });

    const actual = await moveSurface("NAVER");

    for (const action of MOVE_ACTIONS) expect(actual[action]).toMatchObject({ unsupported: true });
  });
});

describe("IMAP_MOVE_ACTIONS_ENABLED on", () => {
  it("NAVER answers the real implementation (no linked id is a soft error, never unsupported)", async () => {
    setFlags({ IMAP_MOVE_ACTIONS_ENABLED: "true" });

    const actual = await moveSurface("NAVER");

    for (const action of MOVE_ACTIONS) {
      expect(actual[action]).toEqual({ error: "Naver actions need the linked mailbox id." });
    }
    expect(h.imapCtor).not.toHaveBeenCalled();
  });

  it("read, star and send stay unsupported while their own flags are off", async () => {
    setFlags({ IMAP_MOVE_ACTIONS_ENABLED: "true" });
    const actions = mailActionsForProvider("NAVER");

    expect(await actions.markAsRead("u1", "id", "row")).toMatchObject({ unsupported: true });
    expect(await actions.toggleRead("u1", "id", true, "row")).toMatchObject({ unsupported: true });
    expect(await actions.toggleStar("u1", "id", true, "row")).toMatchObject({ unsupported: true });
    expect(await actions.sendEmail("u1", "bob@example.com", "s", "b")).toMatchObject({
      unsupported: true,
    });
    expect(
      await actions.createDraft("u1", { to: "bob@example.com", subject: "s", body: "b" }),
    ).toMatchObject({
      unsupported: true,
    });
    expect(actions.provider).toBe("NAVER");
  });

  it.each([
    [{ IMAP_ACTIONS_ENABLED: "true" }, "read/star"],
    [{ IMAP_SEND_ENABLED: "true" }, "send"],
    [{ IMAP_ACTIONS_ENABLED: "true", IMAP_SEND_ENABLED: "true" }, "read/star and send"],
  ] as const)("composes with %j (%s): every enabled surface is real", async (extra) => {
    setFlags({ IMAP_MOVE_ACTIONS_ENABLED: "true", ...extra });
    const actions = mailActionsForProvider("NAVER");

    for (const action of MOVE_ACTIONS) {
      expect(await actions[action]("u1", "id", null)).toEqual({
        error: "Naver actions need the linked mailbox id.",
      });
    }
    const readIsReal = !("unsupported" in (await actions.markAsRead("u1", "id", null)));
    const sendIsReal = !(
      "unsupported" in (await actions.sendEmail("u1", "bob@example.com", "s", "b"))
    );
    expect(readIsReal).toBe("IMAP_ACTIONS_ENABLED" in extra);
    expect(sendIsReal).toBe("IMAP_SEND_ENABLED" in extra);
  });

  it("returns the same object for the same combination of flags", () => {
    setFlags({ IMAP_MOVE_ACTIONS_ENABLED: "true", IMAP_ACTIONS_ENABLED: "true" });
    const first = mailActionsForProvider("NAVER");
    expect(mailActionsForProvider("NAVER")).toBe(first);
  });

  it("ICLOUD stays unsupported until ICLOUD_INBOX_ENABLED is on too", async () => {
    setFlags({ IMAP_MOVE_ACTIONS_ENABLED: "true" });
    const closed = await moveSurface("ICLOUD");
    for (const action of MOVE_ACTIONS) expect(closed[action]).toMatchObject({ unsupported: true });

    setFlags({ IMAP_MOVE_ACTIONS_ENABLED: "true", ICLOUD_INBOX_ENABLED: "true" });
    const open = await moveSurface("ICLOUD");
    for (const action of MOVE_ACTIONS) {
      expect(open[action]).toEqual({ error: "iCloud actions need the linked mailbox id." });
    }
  });

  it("generic IMAP ignores the flag; OUTLOOK and GOOGLE keep their own actions", async () => {
    setFlags({
      IMAP_MOVE_ACTIONS_ENABLED: "true",
      IMAP_ACTIONS_ENABLED: "true",
      IMAP_SEND_ENABLED: "true",
      ICLOUD_INBOX_ENABLED: "true",
    });
    const imap = await moveSurface("IMAP");
    for (const action of MOVE_ACTIONS) expect(imap[action]).toMatchObject({ unsupported: true });
    expect(mailActionsForProvider("IMAP").provider).toBe("IMAP");
    expect(mailActionsForProvider("OUTLOOK").provider).toBe("OUTLOOK");
    expect(mailActionsForProvider("GOOGLE").provider).toBe("GOOGLE");
  });

  it("flipping the flag needs no restart", async () => {
    expect((await moveSurface("NAVER")).trash).toMatchObject({ unsupported: true });
    setFlags({ IMAP_MOVE_ACTIONS_ENABLED: "true" });
    expect((await moveSurface("NAVER")).trash).not.toHaveProperty("unsupported");
    setFlags({});
    expect((await moveSurface("NAVER")).trash).toMatchObject({ unsupported: true });
  });
});
