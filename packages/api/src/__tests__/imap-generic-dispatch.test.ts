/**
 * Step B4: which action surface a generic IMAP mailbox gets. Read/star (B1) and
 * archive/trash (B2) work on it only while their own flag AND GENERIC_IMAP_ENABLED
 * are on. Send, drafts and reply headers (B3) never reach a generic mailbox: the
 * SMTP side is out of scope for B4, whatever IMAP_SEND_ENABLED says.
 *
 * A real implementation answers `{ error }` for a call with no linked mailbox id;
 * the stub answers `unsupported`. That difference is how these tests tell them
 * apart without a server.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ findFirst: vi.fn(), imapCtor: vi.fn() }));

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

const FLAGS = [
  "GENERIC_IMAP_ENABLED",
  "IMAP_ACTIONS_ENABLED",
  "IMAP_MOVE_ACTIONS_ENABLED",
  "IMAP_SEND_ENABLED",
  "ICLOUD_INBOX_ENABLED",
] as const;
type Flag = (typeof FLAGS)[number];
const original = Object.fromEntries(FLAGS.map((name) => [name, process.env[name]]));

function setFlags(on: readonly Flag[]) {
  for (const name of FLAGS) {
    if (on.includes(name)) process.env[name] = "true";
    else delete process.env[name];
  }
}

beforeEach(() => {
  setFlags([]);
  vi.clearAllMocks();
});
afterEach(() => {
  for (const name of FLAGS) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

type Kind = "real" | "stub";

function kindOf(result: unknown): Kind {
  const r = result as { unsupported?: boolean; error?: string };
  if (r.unsupported) return "stub";
  expect(r.error).toBeTruthy(); // a real implementation refuses a call with no mailbox id
  return "real";
}

/** Which of the three groups of actions are real on a mailbox of this provider. */
async function surface(provider: "NAVER" | "ICLOUD" | "IMAP") {
  const actions = mailActionsForProvider(provider);
  return {
    flags: [
      kindOf(await actions.markAsRead("u1", "id", null)),
      kindOf(await actions.toggleRead("u1", "id", true, null)),
      kindOf(await actions.toggleStar("u1", "id", true, null)),
    ],
    moves: [
      kindOf(await actions.trash("u1", "id", null)),
      kindOf(await actions.untrash("u1", "id", null)),
      kindOf(await actions.archive("u1", "id", null)),
      kindOf(await actions.unarchive("u1", "id", null)),
    ],
    send: [
      await actions.sendEmail("u1", "a@example.com", "s", "b"),
      await actions.createDraft("u1", { to: "a@example.com", subject: "s", body: "b" }),
    ],
    replyHeaders: await actions.getReplyHeaders("u1", "id", null),
  };
}

const all = (kind: Kind, n: number) => Array.from({ length: n }, () => kind);
const SEND_REFUSED = {
  unsupported: true,
  error: "This mailbox's provider does not support sending mail from Klorn yet.",
};

describe("GENERIC_IMAP_ENABLED off: a generic mailbox is unsupported, whatever else is on", () => {
  it.each([
    [[]],
    [["IMAP_ACTIONS_ENABLED"]],
    [["IMAP_MOVE_ACTIONS_ENABLED"]],
    [["IMAP_SEND_ENABLED"]],
    [
      [
        "IMAP_ACTIONS_ENABLED",
        "IMAP_MOVE_ACTIONS_ENABLED",
        "IMAP_SEND_ENABLED",
        "ICLOUD_INBOX_ENABLED",
      ],
    ],
  ] as Array<[Flag[]]>)("with %j", async (on) => {
    setFlags(on);
    const s = await surface("IMAP");
    expect(s.flags).toEqual(all("stub", 3));
    expect(s.moves).toEqual(all("stub", 4));
    expect(s.send[0]).toMatchObject(SEND_REFUSED);
    expect(h.imapCtor).not.toHaveBeenCalled();
  });

  it("returns the same unsupported object as before B4", () => {
    setFlags(["IMAP_ACTIONS_ENABLED", "IMAP_MOVE_ACTIONS_ENABLED", "IMAP_SEND_ENABLED"]);
    const a = mailActionsForProvider("IMAP");
    expect(mailActionsForProvider("IMAP")).toBe(a);
    expect(a.provider).toBe("IMAP");
  });
});

describe("GENERIC_IMAP_ENABLED on: each action group needs its own flag too", () => {
  it("on alone: still unsupported (the generic flag opens no action by itself)", async () => {
    setFlags(["GENERIC_IMAP_ENABLED"]);
    const s = await surface("IMAP");
    expect(s.flags).toEqual(all("stub", 3));
    expect(s.moves).toEqual(all("stub", 4));
  });

  it("with IMAP_ACTIONS_ENABLED: read, unread and star are real; moves are not", async () => {
    setFlags(["GENERIC_IMAP_ENABLED", "IMAP_ACTIONS_ENABLED"]);
    const s = await surface("IMAP");
    expect(s.flags).toEqual(all("real", 3));
    expect(s.moves).toEqual(all("stub", 4));
  });

  it("with IMAP_MOVE_ACTIONS_ENABLED: archive, trash and undo are real; read and star are not", async () => {
    setFlags(["GENERIC_IMAP_ENABLED", "IMAP_MOVE_ACTIONS_ENABLED"]);
    const s = await surface("IMAP");
    expect(s.flags).toEqual(all("stub", 3));
    expect(s.moves).toEqual(all("real", 4));
  });

  it("with both action flags: both groups are real", async () => {
    setFlags(["GENERIC_IMAP_ENABLED", "IMAP_ACTIONS_ENABLED", "IMAP_MOVE_ACTIONS_ENABLED"]);
    const s = await surface("IMAP");
    expect(s.flags).toEqual(all("real", 3));
    expect(s.moves).toEqual(all("real", 4));
  });

  it("the generic flag does not open iCloud (the CASA freeze stands)", async () => {
    setFlags(["GENERIC_IMAP_ENABLED", "IMAP_ACTIONS_ENABLED"]);
    const s = await surface("ICLOUD");
    expect(s.flags).toEqual(all("stub", 3));
  });
});

describe("send never reaches a generic mailbox", () => {
  it("IMAP_SEND_ENABLED plus every other flag: send, drafts and reply headers stay unsupported", async () => {
    setFlags([
      "GENERIC_IMAP_ENABLED",
      "IMAP_ACTIONS_ENABLED",
      "IMAP_MOVE_ACTIONS_ENABLED",
      "IMAP_SEND_ENABLED",
    ]);
    const s = await surface("IMAP");
    expect(s.send[0]).toMatchObject(SEND_REFUSED);
    expect(s.send[1]).toMatchObject({ unsupported: true });
    expect(s.replyHeaders).toEqual({});
    // and the read/move groups are real alongside them
    expect(s.flags).toEqual(all("real", 3));
    expect(s.moves).toEqual(all("real", 4));
  });

  it("IMAP_SEND_ENABLED with the generic flag and nothing else: the unsupported stubs", async () => {
    setFlags(["GENERIC_IMAP_ENABLED", "IMAP_SEND_ENABLED"]);
    const s = await surface("IMAP");
    expect(s.send[0]).toMatchObject(SEND_REFUSED);
    const stub = unsupportedMailActions("IMAP");
    expect(await mailActionsForProvider("IMAP").sendEmail("u1", "a@b.co", "s", "b")).toEqual(
      await stub.sendEmail("u1", "a@b.co", "s", "b"),
    );
  });
});

describe("Naver and iCloud do not depend on the generic flag", () => {
  it.each([[[]], [["GENERIC_IMAP_ENABLED"]]] as Array<
    [Flag[]]
  >)("NAVER read/star are real with IMAP_ACTIONS_ENABLED (generic flag: %j)", async (extra) => {
    setFlags(["IMAP_ACTIONS_ENABLED", "IMAP_MOVE_ACTIONS_ENABLED", ...extra]);
    const s = await surface("NAVER");
    expect(s.flags).toEqual(all("real", 3));
    expect(s.moves).toEqual(all("real", 4));
  });

  it("iCloud still needs ICLOUD_INBOX_ENABLED", async () => {
    setFlags(["GENERIC_IMAP_ENABLED", "IMAP_ACTIONS_ENABLED", "ICLOUD_INBOX_ENABLED"]);
    expect((await surface("ICLOUD")).flags).toEqual(all("real", 3));
  });
});
