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

import { beforeEach, describe, expect, it, vi } from "vitest";

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
      await actions.createDraft("u1", "a@b.c", "s", "b"),
      // B0: the reply-context shape is accepted and refused like any draft.
      await actions.createDraft("u1", "a@b.c", "s", "b", "t1", [], "acc-1", {
        inReplyTo: "<m@x>",
        references: "<r@x> <m@x>",
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

    const table: Array<[keyof typeof gmail, () => Promise<unknown>, unknown[]]> = [
      [
        "sendEmail",
        () => actions.sendEmail("u1", "a@b.c", "s", "b", [attachment], options),
        ["u1", "a@b.c", "s", "b", [attachment], options],
      ],
      [
        "createEmailDraft",
        () =>
          actions.createDraft("u1", "a@b.c", "s", "b", "t1", [attachment], "acc-1", {
            inReplyTo: options.inReplyTo,
            references: options.references,
          }),
        [
          "u1",
          "a@b.c",
          "s",
          "b",
          "t1",
          [attachment],
          "acc-1",
          { inReplyTo: options.inReplyTo, references: options.references },
        ],
      ],
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

  it("forwards the reply context of createDraft to createEmailDraft, with the linked account id", async () => {
    const { mailActionsForProvider } = await loadDispatch();
    const actions = mailActionsForProvider("GOOGLE");
    const reply = { inReplyTo: "<m@x>", references: "<r@x> <m@x>" };
    gmail.createEmailDraft.mockResolvedValue({ success: true });

    await actions.createDraft("u1", "a@b.c", "s", "b", "t1", [], "acc-1", reply);

    expect(gmail.createEmailDraft).toHaveBeenCalledWith(
      "u1",
      "a@b.c",
      "s",
      "b",
      "t1",
      [],
      "acc-1",
      reply,
    );
  });

  it("passes no reply context to createEmailDraft when the caller gave none", async () => {
    const { mailActionsForProvider } = await loadDispatch();
    const actions = mailActionsForProvider("GOOGLE");
    gmail.createEmailDraft.mockResolvedValue({ success: true });

    await actions.createDraft("u1", "a@b.c", "s", "b", "t1", [], "acc-1");

    expect(gmail.createEmailDraft.mock.calls[0].slice(0, 7)).toEqual([
      "u1",
      "a@b.c",
      "s",
      "b",
      "t1",
      [],
      "acc-1",
    ]);
    expect(gmail.createEmailDraft.mock.calls[0][7]).toBeUndefined();
  });
});
