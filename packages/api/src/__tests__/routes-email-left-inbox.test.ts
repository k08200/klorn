/**
 * docs/design/mail-cleanup-actions.md, PR1 — the single trash / archive routes
 * and their undo, for every provider:
 *
 *   - a trash or archive that reached the mailbox removes the local row and closes
 *     its attention items, whichever provider ran it (Outlook's Graph move used to
 *     leave the row, and only the bulk route closed attention items);
 *   - an undo restores in the mail's own account: the one the client names, else
 *     the Outlook mailbox embedded in the id, never the primary by assumption;
 *   - an Outlook undo re-syncs through Graph, not through the Gmail path.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

const db = vi.hoisted(() => ({
  emailFindFirst: vi.fn(),
  emailDeleteMany: vi.fn(async () => ({ count: 1 })),
  linkedFindFirst: vi.fn(),
  attentionUpdateMany: vi.fn(async () => ({ count: 1 })),
}));

const gmail = vi.hoisted(() => ({
  trashEmail: vi.fn(),
  untrashEmail: vi.fn(),
  archiveEmail: vi.fn(),
  unarchiveEmail: vi.fn(),
  markLinkedInboxForReconnect: vi.fn(async () => undefined),
}));

const sync = vi.hoisted(() => ({
  syncEmailByGmailId: vi.fn(async () => ({ synced: 1, emailId: "e-gmail-restored" })),
  syncOutlookMessageForUser: vi.fn(),
}));

const outlookBearer = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => {
  const prisma = {
    emailMessage: { findFirst: db.emailFindFirst, deleteMany: db.emailDeleteMany },
    linkedInboxAccount: { findFirst: db.linkedFindFirst },
    attentionItem: { updateMany: db.attentionUpdateMany },
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
vi.mock("../mail/gmail.js", () => gmail);
vi.mock("../mail/email-sync.js", () => ({ syncEmailByGmailId: sync.syncEmailByGmailId }));
vi.mock("../mail/outlook-accounts.js", () => ({
  syncOutlookMessageForUser: sync.syncOutlookMessageForUser,
}));
vi.mock("../mail/outlook-token.js", () => ({ resolveOutlookBearer: outlookBearer }));
vi.mock("../analytics.js", () => ({ recordEvent: vi.fn() }));
vi.mock("../learning/contact-engagement.js", () => ({
  recordContactEngagement: vi.fn(async () => {}),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../billing/entitlement-guard.js", () => ({ requireEntitled: vi.fn(async () => {}) }));
vi.mock("../routes/email.js", () => ({ safeAttachmentFilename: (name: string) => name }));
vi.stubGlobal("fetch", fetchMock);

const TOKEN = signToken({ userId: "user-1", email: "test@example.com" });
const auth = () => ({ authorization: `Bearer ${TOKEN}` });

async function buildApp() {
  const { registerEmailMutationsRoutes } = await import("../routes/email-mutations.js");
  const app = Fastify();
  await app.register(registerEmailMutationsRoutes, { prefix: "/api/email" });
  return app;
}

const OUTLOOK_MAILBOX = "me@outlook.com";
const OUTLOOK_ID = `outlook:${OUTLOOK_MAILBOX}:AAMk-graph-1`;
const OUTLOOK_EMAIL = { id: "e-ol", gmailId: OUTLOOK_ID, linkedInboxAccountId: "acc-ol" };
const PRIMARY_EMAIL = { id: "e-gm", gmailId: "gm-1", linkedInboxAccountId: null };

/** The linked-inbox lookups the routes make: the dispatch by id, the Outlook mailbox by address. */
function linkedAccounts(rows: Array<{ id: string; provider: string; email: string }>) {
  db.linkedFindFirst.mockImplementation(
    async ({ where }: { where: { id?: string; provider?: string; email?: string } }) => {
      const row = rows.find(
        (r) =>
          (where.id === undefined || r.id === where.id) &&
          (where.provider === undefined || r.provider === where.provider) &&
          (where.email === undefined || r.email === where.email),
      );
      return row ? { id: row.id, provider: row.provider } : null;
    },
  );
}

const graphOk = () => ({ ok: true, status: 201, json: async () => ({ id: "AAMk-graph-1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  db.emailDeleteMany.mockResolvedValue({ count: 1 });
  db.attentionUpdateMany.mockResolvedValue({ count: 1 });
  outlookBearer.mockResolvedValue({ accessToken: "at", email: OUTLOOK_MAILBOX });
  fetchMock.mockResolvedValue(graphOk());
  linkedAccounts([{ id: "acc-ol", provider: "OUTLOOK", email: OUTLOOK_MAILBOX }]);
});

const resolvedAttention = (emailId: string) =>
  expect(db.attentionUpdateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        userId: "user-1",
        source: "EMAIL",
        sourceId: { in: [emailId] },
      }),
      data: expect.objectContaining({ status: "RESOLVED" }),
    }),
  );

describe("single trash / archive leave no local row and no open attention item", () => {
  it.each([
    ["DELETE", "/api/email/e-ol", "deleteditems"],
    ["POST", "/api/email/e-ol/archive", "archive"],
  ] as const)("%s %s on Outlook moves the message and removes the row", async (method, url, folder) => {
    db.emailFindFirst.mockResolvedValue(OUTLOOK_EMAIL);
    const app = await buildApp();
    const res = await app.inject({ method, url, headers: auth() });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    const [graphUrl, init] = fetchMock.mock.calls[0];
    expect(graphUrl).toBe("https://graph.microsoft.com/v1.0/me/messages/AAMk-graph-1/move");
    expect(JSON.parse(init.body)).toEqual({ destinationId: folder });
    expect(db.emailDeleteMany).toHaveBeenCalledWith({ where: { userId: "user-1", id: "e-ol" } });
    resolvedAttention("e-ol");
    await app.close();
  });

  it.each([
    ["DELETE", "/api/email/e-gm", "trashEmail"],
    ["POST", "/api/email/e-gm/archive", "archiveEmail"],
  ] as const)("%s %s on Gmail closes the mail's attention items", async (method, url, fn) => {
    db.emailFindFirst.mockResolvedValue(PRIMARY_EMAIL);
    gmail[fn].mockResolvedValue({ success: true });
    const app = await buildApp();
    const res = await app.inject({ method, url, headers: auth() });

    expect(res.statusCode).toBe(200);
    resolvedAttention("e-gm");
    await app.close();
  });

  it("closes attention items on the not-connected local-only removal too", async () => {
    db.emailFindFirst.mockResolvedValue(PRIMARY_EMAIL);
    gmail.trashEmail.mockResolvedValue({ error: "Gmail not connected." });
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: "/api/email/e-gm", headers: auth() });

    expect(res.json()).toEqual({
      success: true,
      warning: "Gmail not connected, removed locally only",
    });
    resolvedAttention("e-gm");
    await app.close();
  });

  it("still answers the archive when closing attention items fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.emailFindFirst.mockResolvedValue(PRIMARY_EMAIL);
    gmail.archiveEmail.mockResolvedValue({ success: true });
    db.attentionUpdateMany.mockRejectedValueOnce(new Error("pooler dropped"));
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/e-gm/archive",
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    await app.close();
  });

  it("removes nothing and closes nothing when the provider refuses", async () => {
    db.emailFindFirst.mockResolvedValue(OUTLOOK_EMAIL);
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: "/api/email/e-ol", headers: auth() });

    expect(res.statusCode).toBe(502);
    expect(db.emailDeleteMany).not.toHaveBeenCalled();
    expect(db.attentionUpdateMany).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("undo restores in the mail's own account", () => {
  it.each([
    ["delete", "untrashEmail"],
    ["archive", "unarchiveEmail"],
  ] as const)("%s undo uses the linked Gmail account the client names", async (action, fn) => {
    linkedAccounts([{ id: "acc-g2", provider: "GOOGLE", email: "two@gmail.com" }]);
    gmail[fn].mockResolvedValue({ success: true });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/email/gm-9/${action}/undo`,
      headers: auth(),
      payload: { gmailId: "gm-9", linkedInboxAccountId: "acc-g2" },
    });

    expect(res.statusCode).toBe(200);
    expect(gmail[fn]).toHaveBeenCalledWith("user-1", "gm-9", "acc-g2");
    expect(sync.syncEmailByGmailId).toHaveBeenCalledWith("user-1", "gm-9", "acc-g2");
    await app.close();
  });

  it.each([
    ["delete", "inbox"],
    ["archive", "inbox"],
  ] as const)("%s undo of an Outlook id finds its mailbox and re-syncs through Graph", async (action, folder) => {
    sync.syncOutlookMessageForUser.mockResolvedValue({ emailId: "e-ol-restored" });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/email/${encodeURIComponent(OUTLOOK_ID)}/${action}/undo`,
      headers: auth(),
      payload: { gmailId: OUTLOOK_ID },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, gmailId: OUTLOOK_ID, emailId: "e-ol-restored" });
    expect(db.linkedFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", provider: "OUTLOOK", email: OUTLOOK_MAILBOX },
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ destinationId: folder });
    expect(sync.syncOutlookMessageForUser).toHaveBeenCalledWith("user-1", "acc-ol", OUTLOOK_ID);
    expect(sync.syncEmailByGmailId).not.toHaveBeenCalled();
    expect(gmail.untrashEmail).not.toHaveBeenCalled();
    expect(gmail.unarchiveEmail).not.toHaveBeenCalled();
    await app.close();
  });

  it("reports an Outlook restore whose re-sync failed as late, not as a failed undo of Gmail", async () => {
    sync.syncOutlookMessageForUser.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/email/${encodeURIComponent(OUTLOOK_ID)}/delete/undo`,
      headers: auth(),
      payload: { gmailId: OUTLOOK_ID, linkedInboxAccountId: "acc-ol" },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/^Restored on Outlook, but Klorn could not refresh its copy/);
    expect(sync.syncEmailByGmailId).not.toHaveBeenCalled();
    await app.close();
  });

  it("never sends a provider-prefixed id to the primary Gmail when its account is gone", async () => {
    linkedAccounts([]);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/email/${encodeURIComponent(OUTLOOK_ID)}/archive/undo`,
      headers: auth(),
      payload: { gmailId: OUTLOOK_ID },
    });

    expect(res.statusCode).toBe(409);
    expect(gmail.unarchiveEmail).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });
});
