/**
 * What the trash, archive and undo routes do with the provider results for NAVER
 * and ICLOUD (step B2 of docs/providers/unified-platform-plan.md).
 *
 * The provider layer is scripted here; its own behaviour is in
 * imap-move-actions.test.ts. These pin the route side:
 *   - `{ error }` from an IMAP provider is a failed or refused move, NOT "account
 *     not connected": the message is still in the mailbox, so the route must not
 *     delete or hide the local row (the Gmail and Outlook fallback stays as it was);
 *   - a bulk archive of IMAP mail puts all its moves in flight together (so they
 *     coalesce into one login and one UID MOVE), while Gmail keeps its order;
 *   - undo finds the mailbox from the recorded move when the client sends no
 *     account id, re-syncs the restored message under its NEW id, and answers that
 *     id; with the flag off none of that runs and the answer is the old 501.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

const h = vi.hoisted(() => ({
  emailFindFirst: vi.fn(),
  emailFindMany: vi.fn(),
  emailDeleteMany: vi.fn(async () => ({ count: 1 })),
  emailUpdate: vi.fn(async () => ({})),
  mailActionsFor: vi.fn(),
  syncEmailByGmailId: vi.fn(),
  syncImapMessageForUser: vi.fn(),
  findMovedAccountId: vi.fn(),
  recordEvent: vi.fn(),
}));

vi.mock("../db.js", () => {
  const prisma = {
    emailMessage: {
      findFirst: h.emailFindFirst,
      findMany: h.emailFindMany,
      deleteMany: h.emailDeleteMany,
      update: h.emailUpdate,
    },
    user: {
      findUnique: vi.fn(async () => ({
        id: "user-1",
        email: "test@example.com",
        role: "USER",
        sessionsInvalidatedAt: null,
      })),
    },
    device: {
      findUnique: vi.fn(async () => ({
        id: "device-1",
        lastActiveAt: new Date(),
        createdAt: new Date(),
      })),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../mail/providers/dispatch.js", () => ({ mailActionsFor: h.mailActionsFor }));
vi.mock("../mail/email-sync.js", () => ({ syncEmailByGmailId: h.syncEmailByGmailId }));
vi.mock("../mail/imap-accounts.js", () => ({ syncImapMessageForUser: h.syncImapMessageForUser }));
vi.mock("../mail/providers/imap-moved.js", () => ({ findMovedAccountId: h.findMovedAccountId }));
vi.mock("../analytics.js", () => ({ recordEvent: h.recordEvent }));
vi.mock("../learning/contact-engagement.js", () => ({
  recordContactEngagement: vi.fn(async () => {}),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../billing/entitlement-guard.js", () => ({ requireEntitled: vi.fn(async () => {}) }));
vi.mock("../routes/email.js", () => ({ safeAttachmentFilename: (name: string) => name }));

const TOKEN = signToken({ userId: "user-1", email: "test@example.com" });
const auth = () => ({ authorization: `Bearer ${TOKEN}` });

async function buildApp() {
  const { registerEmailMutationsRoutes } = await import("../routes/email-mutations.js");
  const { registerEmailBulkRoutes } = await import("../routes/email-bulk.js");
  const app = Fastify();
  await app.register(registerEmailMutationsRoutes, { prefix: "/api/email" });
  await app.register(registerEmailBulkRoutes, { prefix: "/api/email" });
  return app;
}

type Provider = "GOOGLE" | "OUTLOOK" | "NAVER" | "ICLOUD";

/** A scripted action surface for one provider. */
function surface(provider: Provider, results: Record<string, unknown> = {}) {
  const call = (name: string, fallback: unknown) =>
    vi.fn(async () => (name in results ? results[name] : fallback));
  return {
    provider,
    trash: call("trash", { success: true }),
    untrash: call("untrash", { success: true }),
    archive: call("archive", { success: true }),
    unarchive: call("unarchive", { success: true }),
  };
}

const NAVER_EMAIL = {
  id: "e-naver",
  gmailId: "naver-imap:me@naver.com:42",
  linkedInboxAccountId: "acc-naver",
};
const FLAG = "IMAP_MOVE_ACTIONS_ENABLED";
const originalFlag = process.env[FLAG];

beforeEach(() => {
  vi.clearAllMocks();
  h.emailDeleteMany.mockResolvedValue({ count: 1 });
  h.findMovedAccountId.mockResolvedValue(null);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  if (originalFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = originalFlag;
});

describe("DELETE /api/email/:id (trash)", () => {
  it.each([
    "NAVER",
    "ICLOUD",
  ] as const)("keeps the local row and answers 502 when %s answers { error }", async (provider) => {
    h.emailFindFirst.mockResolvedValue(NAVER_EMAIL);
    h.mailActionsFor.mockResolvedValue(
      surface(provider, { trash: { error: "Naver did not confirm the move." } }),
    );

    const res = await (await buildApp()).inject({
      method: "DELETE",
      url: "/api/email/e-naver",
      headers: auth(),
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "Naver did not confirm the move." });
    expect(h.emailDeleteMany).not.toHaveBeenCalled();
  });

  it("answers 200 without touching the row itself when the IMAP provider confirmed (it removed the row)", async () => {
    h.emailFindFirst.mockResolvedValue(NAVER_EMAIL);
    h.mailActionsFor.mockResolvedValue(surface("NAVER"));

    const res = await (await buildApp()).inject({
      method: "DELETE",
      url: "/api/email/e-naver",
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(h.emailDeleteMany).not.toHaveBeenCalled();
  });

  it("still answers 501 for an unsupported provider, with no local write", async () => {
    h.emailFindFirst.mockResolvedValue(NAVER_EMAIL);
    h.mailActionsFor.mockResolvedValue(
      surface("NAVER", {
        trash: {
          unsupported: true,
          error: "This mailbox's provider does not support delete from Klorn yet.",
        },
      }),
    );

    const res = await (await buildApp()).inject({
      method: "DELETE",
      url: "/api/email/e-naver",
      headers: auth(),
    });

    expect(res.statusCode).toBe(501);
    expect(h.emailDeleteMany).not.toHaveBeenCalled();
  });

  it.each([
    "GOOGLE",
    "OUTLOOK",
  ] as const)("keeps the local-only fallback for %s when it is not connected", async (provider) => {
    h.emailFindFirst.mockResolvedValue({ id: "e-g", gmailId: "gm-1", linkedInboxAccountId: null });
    h.mailActionsFor.mockResolvedValue(
      surface(provider, { trash: { error: "Gmail not connected." } }),
    );

    const res = await (await buildApp()).inject({
      method: "DELETE",
      url: "/api/email/e-g",
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      warning: "Gmail not connected, removed locally only",
    });
    expect(h.emailDeleteMany).toHaveBeenCalledWith({ where: { id: "e-g" } });
  });
});

describe("POST /api/email/:id/archive", () => {
  it("keeps the local row, records no event and answers 502 when NAVER answers { error }", async () => {
    h.emailFindFirst.mockResolvedValue(NAVER_EMAIL);
    h.mailActionsFor.mockResolvedValue(
      surface("NAVER", { archive: { error: "Naver reset its mailbox numbering." } }),
    );

    const res = await (await buildApp()).inject({
      method: "POST",
      url: "/api/email/e-naver/archive",
      headers: auth(),
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "Naver reset its mailbox numbering." });
    expect(h.emailDeleteMany).not.toHaveBeenCalled();
    expect(h.recordEvent).not.toHaveBeenCalled();
  });

  it("records the retention event and answers 200 when NAVER confirmed", async () => {
    h.emailFindFirst.mockResolvedValue(NAVER_EMAIL);
    h.mailActionsFor.mockResolvedValue(surface("NAVER"));

    const res = await (await buildApp()).inject({
      method: "POST",
      url: "/api/email/e-naver/archive",
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    expect(h.recordEvent).toHaveBeenCalledWith("user-1", "queue_action", { action: "archive" });
  });

  it("keeps the local-only fallback for a Gmail account that is not connected", async () => {
    h.emailFindFirst.mockResolvedValue({ id: "e-g", gmailId: "gm-1", linkedInboxAccountId: null });
    h.mailActionsFor.mockResolvedValue(
      surface("GOOGLE", { archive: { error: "Gmail not connected." } }),
    );

    const res = await (await buildApp()).inject({
      method: "POST",
      url: "/api/email/e-g/archive",
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ warning: "Gmail not connected, removed locally only" });
    expect(h.emailDeleteMany).toHaveBeenCalledWith({ where: { id: "e-g" } });
  });
});

describe("POST /api/email/bulk archive", () => {
  const bulk = (app: Awaited<ReturnType<typeof buildApp>>, ids: string[]) =>
    app.inject({
      method: "POST",
      url: "/api/email/bulk",
      headers: auth(),
      payload: { action: "archive", ids },
    });

  it("puts every IMAP archive in flight before any settles, so the queue can coalesce them", async () => {
    const emails = ["a", "b", "c"].map((k) => ({
      id: `e-${k}`,
      gmailId: `naver-imap:me@naver.com:${k.charCodeAt(0)}`,
      linkedInboxAccountId: "acc-naver",
    }));
    h.emailFindMany.mockResolvedValue(emails);
    let inFlight = 0;
    let peak = 0;
    const actions = {
      ...surface("NAVER"),
      archive: vi.fn(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { success: true };
      }),
    };
    h.mailActionsFor.mockResolvedValue(actions);

    const res = await bulk(await buildApp(), ["e-a", "e-b", "e-c"]);

    expect(res.json()).toEqual({ success: true, updatedCount: 3, failed: [] });
    expect(peak).toBe(3);
  });

  it("keeps Gmail archives one at a time, in order", async () => {
    const emails = ["a", "b", "c"].map((k) => ({
      id: `e-${k}`,
      gmailId: `gm-${k}`,
      linkedInboxAccountId: null,
    }));
    h.emailFindMany.mockResolvedValue(emails);
    const order: string[] = [];
    let inFlight = 0;
    let peak = 0;
    h.mailActionsFor.mockResolvedValue({
      ...surface("GOOGLE"),
      archive: vi.fn(async (_u: string, gmailId: string) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        order.push(gmailId);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        return { success: true };
      }),
    });

    const res = await bulk(await buildApp(), ["e-a", "e-b", "e-c"]);

    expect(res.json()).toMatchObject({ updatedCount: 3 });
    expect(order).toEqual(["gm-a", "gm-b", "gm-c"]);
    expect(peak).toBe(1);
  });

  it("reports the IMAP items that failed, keeps their rows, and archives the others", async () => {
    const emails = ["a", "b", "c"].map((k) => ({
      id: `e-${k}`,
      gmailId: `naver-imap:me@naver.com:${k.charCodeAt(0)}`,
      linkedInboxAccountId: "acc-naver",
    }));
    h.emailFindMany.mockResolvedValue(emails);
    h.mailActionsFor.mockResolvedValue({
      ...surface("NAVER"),
      archive: vi.fn(async (_u: string, gmailId: string) =>
        gmailId.endsWith(":98") ? { error: "Naver did not confirm the move." } : { success: true },
      ),
    });

    const res = await bulk(await buildApp(), ["e-a", "e-b", "e-c"]);

    expect(res.json()).toEqual({
      success: false,
      updatedCount: 2,
      failed: [{ id: "e-b", error: "Naver did not confirm the move." }],
    });
    expect(h.emailDeleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", id: { in: ["e-a", "e-c"] } },
    });
  });

  it("isolates a provider lookup failure to its own item", async () => {
    h.emailFindMany.mockResolvedValue([
      { id: "e-a", gmailId: "gm-a", linkedInboxAccountId: null },
      { id: "e-b", gmailId: "gm-b", linkedInboxAccountId: null },
    ]);
    h.mailActionsFor
      .mockRejectedValueOnce(new Error("pooler dropped"))
      .mockResolvedValueOnce(surface("GOOGLE"));

    const res = await bulk(await buildApp(), ["e-a", "e-b"]);

    expect(res.json()).toEqual({
      success: false,
      updatedCount: 1,
      failed: [{ id: "e-a", error: "pooler dropped" }],
    });
  });
});

describe("POST /api/email/:id/{delete,archive}/undo", () => {
  const undoBody = { gmailId: "naver-imap:me@naver.com:42" };

  it("re-syncs an IMAP message under its NEW id and answers that id", async () => {
    process.env[FLAG] = "true";
    h.findMovedAccountId.mockResolvedValue("acc-naver");
    h.mailActionsFor.mockResolvedValue(
      surface("NAVER", {
        untrash: { success: true, restoredMessageId: "naver-imap:me@naver.com:77" },
      }),
    );
    h.syncImapMessageForUser.mockResolvedValue({ emailId: "e-new" });

    const res = await (await buildApp()).inject({
      method: "POST",
      url: "/api/email/x/delete/undo",
      headers: auth(),
      payload: undoBody,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      gmailId: "naver-imap:me@naver.com:77",
      emailId: "e-new",
    });
    expect(h.syncImapMessageForUser).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ provider: "NAVER" }),
      "acc-naver",
      "naver-imap:me@naver.com:77",
    );
    expect(h.syncEmailByGmailId).not.toHaveBeenCalled();
  });

  it("finds the mailbox from the recorded move when the client sent no account id", async () => {
    process.env[FLAG] = "true";
    h.findMovedAccountId.mockResolvedValue("acc-naver");
    h.mailActionsFor.mockResolvedValue(
      surface("NAVER", {
        unarchive: { success: true, restoredMessageId: "naver-imap:me@naver.com:78" },
      }),
    );
    h.syncImapMessageForUser.mockResolvedValue({ emailId: "e-new" });

    await (await buildApp()).inject({
      method: "POST",
      url: "/api/email/x/archive/undo",
      headers: auth(),
      payload: undoBody,
    });

    expect(h.findMovedAccountId).toHaveBeenCalledWith(
      "user-1",
      "naver-imap:me@naver.com:42",
      "ARCHIVE",
    );
    expect(h.mailActionsFor).toHaveBeenCalledWith("user-1", "acc-naver");
  });

  it("uses the account id the client sent, without looking anything up", async () => {
    process.env[FLAG] = "true";
    h.mailActionsFor.mockResolvedValue(
      surface("NAVER", {
        untrash: { success: true, restoredMessageId: "naver-imap:me@naver.com:79" },
      }),
    );
    h.syncImapMessageForUser.mockResolvedValue({ emailId: "e-new" });

    await (await buildApp()).inject({
      method: "POST",
      url: "/api/email/x/delete/undo",
      headers: auth(),
      payload: { ...undoBody, linkedInboxAccountId: "acc-given" },
    });

    expect(h.findMovedAccountId).not.toHaveBeenCalled();
    expect(h.mailActionsFor).toHaveBeenCalledWith("user-1", "acc-given");
  });

  it("does not look at the record for a Gmail id", async () => {
    process.env[FLAG] = "true";
    h.mailActionsFor.mockResolvedValue(surface("GOOGLE"));
    h.syncEmailByGmailId.mockResolvedValue({ emailId: "e1" });

    const res = await (await buildApp()).inject({
      method: "POST",
      url: "/api/email/18c2f0a1/delete/undo",
      headers: auth(),
      payload: { gmailId: "18c2f0a1" },
    });

    expect(res.statusCode).toBe(200);
    expect(h.findMovedAccountId).not.toHaveBeenCalled();
    expect(h.syncEmailByGmailId).toHaveBeenCalledWith("user-1", "18c2f0a1", null);
  });

  it("does not look at the record at all while the flag is off (the old 501)", async () => {
    h.mailActionsFor.mockResolvedValue(
      surface("GOOGLE", {
        untrash: {
          unsupported: true,
          error: "This mailbox's provider does not support restore from Klorn yet.",
        },
      }),
    );

    const res = await (await buildApp()).inject({
      method: "POST",
      url: "/api/email/x/delete/undo",
      headers: auth(),
      payload: undoBody,
    });

    expect(res.statusCode).toBe(501);
    expect(h.findMovedAccountId).not.toHaveBeenCalled();
    expect(h.mailActionsFor).toHaveBeenCalledWith("user-1", null);
  });

  it("answers 409 for { error } and never re-syncs", async () => {
    process.env[FLAG] = "true";
    h.findMovedAccountId.mockResolvedValue("acc-naver");
    h.mailActionsFor.mockResolvedValue(
      surface("NAVER", {
        untrash: { error: "Klorn has no record of moving this message, so it cannot restore it." },
      }),
    );

    const res = await (await buildApp()).inject({
      method: "POST",
      url: "/api/email/x/delete/undo",
      headers: auth(),
      payload: undoBody,
    });

    expect(res.statusCode).toBe(409);
    expect(h.syncImapMessageForUser).not.toHaveBeenCalled();
  });

  it("says the message is back, and will reappear, when the local re-sync fails after a confirmed restore", async () => {
    process.env[FLAG] = "true";
    h.findMovedAccountId.mockResolvedValue("acc-naver");
    h.mailActionsFor.mockResolvedValue(
      surface("NAVER", {
        untrash: { success: true, restoredMessageId: "naver-imap:me@naver.com:77" },
      }),
    );
    h.syncImapMessageForUser.mockRejectedValue(new Error("socket hang up for me@naver.com"));

    const res = await (await buildApp()).inject({
      method: "POST",
      url: "/api/email/x/delete/undo",
      headers: auth(),
      payload: undoBody,
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/restored/i);
    expect(res.json().error).toMatch(/next sync/i);
    expect(res.body).not.toContain("me@naver.com");
  });

  it("treats a restored message that cannot be found in INBOX as the same partial success", async () => {
    process.env[FLAG] = "true";
    h.findMovedAccountId.mockResolvedValue("acc-naver");
    h.mailActionsFor.mockResolvedValue(
      surface("NAVER", {
        untrash: { success: true, restoredMessageId: "naver-imap:me@naver.com:77" },
      }),
    );
    h.syncImapMessageForUser.mockResolvedValue(null);

    const res = await (await buildApp()).inject({
      method: "POST",
      url: "/api/email/x/delete/undo",
      headers: auth(),
      payload: undoBody,
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/next sync/i);
  });
});
