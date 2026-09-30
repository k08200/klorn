/**
 * MailProviderActions dispatch (Phase 1 of the multi-provider plan,
 * docs/providers/multi-provider-plan.md).
 *
 * The action surface (send/read/star/trash/archive…) dispatches by the
 * provider of the mailbox a message lives on. GOOGLE delegates to the Gmail
 * module; providers with no action surface yet (NAVER today, ICLOUD/
 * IMAP until their phases land) answer every mutation with an explicit
 * `unsupported` result — never a plain `{ error }`, because callers treat
 * `{ error }` as "not connected" and fall back to local-only writes, which is
 * the false-200/resurrection bug Phase 0b fixed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { imapActionsEnabled } from "../config.js";
import type { MailProviderActions } from "../mail/providers/types.js";

const db = vi.hoisted(() => ({ findFirst: vi.fn() }));

const gmail = vi.hoisted(() => ({
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

vi.mock("../db.js", () => {
  const prisma = { linkedInboxAccount: { findFirst: db.findFirst } };
  return { prisma, db: prisma };
});

vi.mock("../mail/gmail.js", () => gmail);

async function loadDispatch() {
  return import("../mail/providers/dispatch.js");
}

// The dispatch table reads IMAP_ACTIONS_ENABLED at request time; keep every
// test in this file independent of the developer's shell.
const ORIGINAL_IMAP_ACTIONS_FLAG = process.env.IMAP_ACTIONS_ENABLED;
function setImapActionsFlag(value: string | undefined) {
  if (value === undefined) delete process.env.IMAP_ACTIONS_ENABLED;
  else process.env.IMAP_ACTIONS_ENABLED = value;
}
beforeEach(() => setImapActionsFlag(undefined));
afterEach(() => setImapActionsFlag(ORIGINAL_IMAP_ACTIONS_FLAG));

describe("mailActionsFor", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves the primary inbox (null id) to GOOGLE without touching the DB", async () => {
    const { mailActionsFor } = await loadDispatch();
    const actions = await mailActionsFor("u1", null);
    expect(actions.provider).toBe("GOOGLE");
    expect(db.findFirst).not.toHaveBeenCalled();
  });

  it("resolves a linked row by its provider column, scoped to the user", async () => {
    db.findFirst.mockResolvedValue({ provider: "NAVER" });
    const { mailActionsFor } = await loadDispatch();
    const actions = await mailActionsFor("u1", "row-1");
    expect(actions.provider).toBe("NAVER");
    expect(db.findFirst).toHaveBeenCalledWith({
      where: { id: "row-1", userId: "u1" },
      select: { provider: true },
    });
  });

  it("treats a missing row as GOOGLE — the caller's normal not-connected path handles a stale id", async () => {
    db.findFirst.mockResolvedValue(null);
    const { mailActionsFor } = await loadDispatch();
    const actions = await mailActionsFor("u1", "row-gone");
    expect(actions.provider).toBe("GOOGLE");
  });
});

describe("mailActionsForProvider", () => {
  it.each([
    "NAVER",
    "ICLOUD",
    "IMAP",
  ] as const)("%s has no action surface yet — every mutation answers unsupported", async (provider) => {
    const { mailActionsForProvider } = await loadDispatch();
    const actions = mailActionsForProvider(provider);
    expect(actions.provider).toBe(provider);

    const results = [
      await actions.sendEmail("u1", "a@b.c", "s", "b"),
      await actions.createDraft("u1", { to: "a@b.c", subject: "s", body: "b" }),
      // B0: the reply-context shape is accepted and refused like any draft.
      await actions.createDraft("u1", {
        to: "a@b.c",
        subject: "s",
        body: "b",
        threadId: "t1",
        attachments: [],
        linkedInboxAccountId: "acc-1",
        reply: { inReplyTo: "<m@x>", references: "<r@x> <m@x>" },
      }),
      await actions.markAsRead("u1", "m1"),
      await actions.toggleRead("u1", "m1", true),
      await actions.toggleStar("u1", "m1", true),
      await actions.trash("u1", "m1"),
      await actions.untrash("u1", "m1"),
      await actions.archive("u1", "m1"),
      await actions.unarchive("u1", "m1"),
    ];
    for (const result of results) {
      expect(result).toMatchObject({ unsupported: true });
      expect((result as { error: string }).error).toMatch(
        /^This mailbox's provider does not support .+ from Klorn yet\.$/,
      );
    }
    // None of the refusals may have leaked into the Gmail module.
    for (const fn of Object.values(gmail)) expect(fn).not.toHaveBeenCalled();
  });

  it("keeps the exact wire copy the 0b routes shipped for delete and archive", async () => {
    const { mailActionsForProvider } = await loadDispatch();
    const actions = mailActionsForProvider("NAVER");
    expect(await actions.trash("u1", "m1")).toEqual({
      unsupported: true,
      error: "This mailbox's provider does not support delete from Klorn yet.",
    });
    expect(await actions.archive("u1", "m1")).toEqual({
      unsupported: true,
      error: "This mailbox's provider does not support archive from Klorn yet.",
    });
  });

  it("returns {} from getReplyHeaders — reply threading is best-effort by contract", async () => {
    const { mailActionsForProvider } = await loadDispatch();
    expect(await mailActionsForProvider("NAVER").getReplyHeaders("u1", "m1")).toEqual({});
  });
});

describe("GOOGLE actions delegate to the Gmail module", () => {
  beforeEach(() => vi.clearAllMocks());

  it("forwards every action with its arguments and returns the Gmail result", async () => {
    const { mailActionsForProvider } = await loadDispatch();
    const actions = mailActionsForProvider("GOOGLE");
    const attachment = { filename: "a.txt", mimeType: "text/plain", content: Buffer.from("x") };
    const options = {
      threadId: "t1",
      inReplyTo: "<m@x>",
      references: "<m@x>",
      linkedInboxAccountId: "acc-1",
    };

    const draft = {
      to: "a@b.c",
      subject: "s",
      body: "b",
      threadId: "t1",
      attachments: [attachment],
      linkedInboxAccountId: "acc-1",
      reply: { inReplyTo: options.inReplyTo, references: options.references },
    };

    const table: Array<[keyof typeof gmail, () => Promise<unknown>, unknown[]]> = [
      [
        "sendEmail",
        () => actions.sendEmail("u1", "a@b.c", "s", "b", [attachment], options),
        ["u1", "a@b.c", "s", "b", [attachment], options],
      ],
      ["createEmailDraft", () => actions.createDraft("u1", draft), ["u1", draft]],
      [
        "getReplyHeaders",
        () => actions.getReplyHeaders("u1", "m1", "acc-1"),
        ["u1", "m1", "acc-1"],
      ],
      ["markAsRead", () => actions.markAsRead("u1", "m1", "acc-1"), ["u1", "m1", "acc-1"]],
      [
        "toggleReadGmail",
        () => actions.toggleRead("u1", "m1", true, "acc-1"),
        ["u1", "m1", true, "acc-1"],
      ],
      [
        "toggleStarGmail",
        () => actions.toggleStar("u1", "m1", false, "acc-1"),
        ["u1", "m1", false, "acc-1"],
      ],
      ["trashEmail", () => actions.trash("u1", "m1", "acc-1"), ["u1", "m1", "acc-1"]],
      ["untrashEmail", () => actions.untrash("u1", "m1", "acc-1"), ["u1", "m1", "acc-1"]],
      ["archiveEmail", () => actions.archive("u1", "m1", "acc-1"), ["u1", "m1", "acc-1"]],
      ["unarchiveEmail", () => actions.unarchive("u1", "m1", "acc-1"), ["u1", "m1", "acc-1"]],
    ];

    for (const [fnName, call, expectedArgs] of table) {
      const sentinel = { success: true as const, via: fnName };
      gmail[fnName].mockResolvedValue(sentinel);
      expect(await call()).toBe(sentinel);
      expect(gmail[fnName]).toHaveBeenCalledWith(...expectedArgs);
    }
  });

  it("adds no reply context of its own when the caller gave none", async () => {
    const { mailActionsForProvider } = await loadDispatch();
    const actions = mailActionsForProvider("GOOGLE");
    const draft = { to: "a@b.c", subject: "s", body: "b", threadId: "t1" };
    gmail.createEmailDraft.mockResolvedValue({ success: true });

    await actions.createDraft("u1", draft);

    const passed = gmail.createEmailDraft.mock.calls[0][1];
    expect(passed).toStrictEqual(draft);
    expect(passed).not.toHaveProperty("reply");
  });
});

describe("IMAP flag actions are gated by IMAP_ACTIONS_ENABLED (step B1)", () => {
  const MUTATIONS = [
    "sendEmail",
    "createDraft",
    "markAsRead",
    "toggleRead",
    "toggleStar",
    "trash",
    "untrash",
    "archive",
    "unarchive",
  ] as const;

  async function callMutation(actions: MailProviderActions, name: (typeof MUTATIONS)[number]) {
    switch (name) {
      case "sendEmail":
        return actions.sendEmail("u1", "a@b.c", "s", "b");
      case "createDraft":
        return actions.createDraft("u1", { to: "a@b.c", subject: "s", body: "b" });
      case "markAsRead":
        return actions.markAsRead("u1", "m1");
      case "toggleRead":
        return actions.toggleRead("u1", "m1", true);
      case "toggleStar":
        return actions.toggleStar("u1", "m1", true);
      default:
        return actions[name]("u1", "m1");
    }
  }

  describe("imapActionsEnabled (lenient parse, read at request time)", () => {
    it.each([
      [undefined, false],
      ["", false],
      ["   ", false],
      ["false", false],
      ["0", false],
      ["off", false],
      ["no", false],
      ["tru", false],
      ["true", true],
      ["TRUE", true],
      [" True ", true],
      ["1", true],
      ["yes", true],
      ["on", true],
    ])("IMAP_ACTIONS_ENABLED=%j -> %s", (raw, expected) => {
      setImapActionsFlag(raw);
      expect(imapActionsEnabled()).toBe(expected);
    });
  });

  describe("flag OFF: byte-identical to today", () => {
    it.each([
      "NAVER",
      "ICLOUD",
      "IMAP",
    ] as const)("%s answers the unsupported refusal for every mutation", async (provider) => {
      const { mailActionsForProvider } = await loadDispatch();
      const { unsupportedMailActions } = await import("../mail/providers/unsupported.js");
      for (const raw of [undefined, "", "false", "0", "off"]) {
        setImapActionsFlag(raw);
        const actions = mailActionsForProvider(provider);
        const baseline = unsupportedMailActions(provider);
        expect(actions.provider).toBe(provider);
        for (const name of MUTATIONS) {
          const got = await callMutation(actions, name);
          expect(got).toEqual(await callMutation(baseline, name));
          expect(got).toMatchObject({ unsupported: true });
        }
      }
    });

    it("keeps the exact wire copy for mark-as-read and star", async () => {
      const { mailActionsForProvider } = await loadDispatch();
      const actions = mailActionsForProvider("NAVER");
      expect(await actions.markAsRead("u1", "m1")).toEqual({
        unsupported: true,
        error: "This mailbox's provider does not support mark as read from Klorn yet.",
      });
      expect(await actions.toggleStar("u1", "m1", true)).toEqual({
        unsupported: true,
        error: "This mailbox's provider does not support star from Klorn yet.",
      });
    });
  });

  describe("flag ON", () => {
    it.each([
      "NAVER",
      "ICLOUD",
    ] as const)("%s routes read and star to the IMAP implementation", async (provider) => {
      setImapActionsFlag("true");
      const { mailActionsForProvider } = await loadDispatch();
      const actions = mailActionsForProvider(provider);
      expect(actions.provider).toBe(provider);

      // No linked inbox id -> the IMAP implementation refuses softly, without a
      // DB lookup or a connection. What matters here: NOT the unsupported refusal.
      for (const result of [
        await actions.markAsRead("u1", "m1"),
        await actions.toggleRead("u1", "m1", false),
        await actions.toggleStar("u1", "m1", true),
      ]) {
        expect(result).toMatchObject({ error: expect.any(String) });
        expect(result).not.toHaveProperty("unsupported");
      }
    });

    it.each([
      "NAVER",
      "ICLOUD",
    ] as const)("%s keeps send, drafts, trash and archive unsupported (B2/B3 territory)", async (provider) => {
      setImapActionsFlag("true");
      const { mailActionsForProvider } = await loadDispatch();
      const actions = mailActionsForProvider(provider);
      for (const name of [
        "sendEmail",
        "createDraft",
        "trash",
        "untrash",
        "archive",
        "unarchive",
      ] as const) {
        expect(await callMutation(actions, name)).toMatchObject({ unsupported: true });
      }
      expect(await actions.getReplyHeaders("u1", "m1")).toEqual({});
    });

    it("leaves generic IMAP unsupported for every mutation", async () => {
      setImapActionsFlag("true");
      const { mailActionsForProvider } = await loadDispatch();
      const actions = mailActionsForProvider("IMAP");
      expect(actions.provider).toBe("IMAP");
      for (const name of MUTATIONS) {
        expect(await callMutation(actions, name)).toMatchObject({ unsupported: true });
      }
    });

    it("does not touch GOOGLE or OUTLOOK routing", async () => {
      setImapActionsFlag("true");
      const { mailActionsForProvider } = await loadDispatch();
      expect(mailActionsForProvider("GOOGLE").provider).toBe("GOOGLE");
      expect(mailActionsForProvider("OUTLOOK").provider).toBe("OUTLOOK");
    });

    it("re-reads the flag on every call (no restart needed to flip it)", async () => {
      const { mailActionsForProvider } = await loadDispatch();
      setImapActionsFlag(undefined);
      expect(await mailActionsForProvider("NAVER").markAsRead("u1", "m1")).toMatchObject({
        unsupported: true,
      });
      setImapActionsFlag("true");
      expect(await mailActionsForProvider("NAVER").markAsRead("u1", "m1")).not.toHaveProperty(
        "unsupported",
      );
      setImapActionsFlag("false");
      expect(await mailActionsForProvider("NAVER").markAsRead("u1", "m1")).toMatchObject({
        unsupported: true,
      });
    });

    it("mailActionsFor dispatches a linked NAVER row to the IMAP implementation only while the flag is on", async () => {
      db.findFirst.mockResolvedValue({ provider: "NAVER" });
      const { mailActionsFor } = await loadDispatch();

      setImapActionsFlag(undefined);
      expect(
        await (await mailActionsFor("u1", "row-1")).toggleRead("u1", "m1", true),
      ).toMatchObject({
        unsupported: true,
      });

      setImapActionsFlag("on");
      expect(
        await (await mailActionsFor("u1", "row-1")).toggleRead("u1", "m1", true),
      ).not.toHaveProperty("unsupported");
    });
  });
});
