/**
 * Provider contract of the single-item mutation routes (Phase 0b finding,
 * kept green through the Phase 1 dispatch refactor):
 *
 *   - a message on a provider with no action surface (NAVER) → 501, no local
 *     write — never the "removed locally" fallback whose false 200 the next
 *     IMAP poll resurrects;
 *   - a Google message with a live client → real action, 200;
 *   - a Google message with no client ({ error } from the Gmail module) →
 *     local-only fallback with an explicit warning.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

const db = vi.hoisted(() => ({
  emailFindFirst: vi.fn(),
  emailDeleteMany: vi.fn(async () => ({ count: 1 })),
  emailUpdate: vi.fn(async () => ({})),
  linkedFindFirst: vi.fn(),
}));

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
  const prisma = {
    emailMessage: {
      findFirst: db.emailFindFirst,
      deleteMany: db.emailDeleteMany,
      update: db.emailUpdate,
    },
    linkedInboxAccount: { findFirst: db.linkedFindFirst },
    // requireAuth resolves the user and validates the device session on every
    // request — without these rows every route answers 401.
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
vi.mock("../mail/email-sync.js", () => ({
  syncEmailByGmailId: vi.fn(async () => ({ synced: true, emailId: "e1" })),
}));
vi.mock("../analytics.js", () => ({ recordEvent: vi.fn() }));
vi.mock("../learning/contact-engagement.js", () => ({
  recordContactEngagement: vi.fn(async () => {}),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../billing/entitlement-guard.js", () => ({
  requireEntitled: vi.fn(async () => {}),
}));
vi.mock("../routes/email.js", () => ({
  safeAttachmentFilename: (name: string) => name,
}));

const TOKEN = signToken({ userId: "user-1", email: "test@example.com" });

function auth() {
  return { authorization: `Bearer ${TOKEN}` };
}

async function buildApp() {
  const { registerEmailMutationsRoutes } = await import("../routes/email-mutations.js");
  const app = Fastify();
  await app.register(registerEmailMutationsRoutes, { prefix: "/api/email" });
  return app;
}

const NAVER_EMAIL = {
  id: "e-naver",
  gmailId: "naver-imap:me@naver.com:42",
  linkedInboxAccountId: "acc-naver",
};
const PRIMARY_EMAIL = { id: "e-google", gmailId: "gm-1", linkedInboxAccountId: null };

describe("email mutation routes × provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.emailDeleteMany.mockResolvedValue({ count: 1 });
  });

  describe("DELETE /api/email/:id", () => {
    it("refuses a NAVER-linked message with 501 and writes nothing locally", async () => {
      db.emailFindFirst.mockResolvedValue(NAVER_EMAIL);
      db.linkedFindFirst.mockResolvedValue({ provider: "NAVER" });

      const app = await buildApp();
      const res = await app.inject({
        method: "DELETE",
        url: "/api/email/e-naver",
        headers: auth(),
      });

      expect(res.statusCode).toBe(501);
      expect(res.json()).toEqual({
        error: "This mailbox's provider does not support delete from Klorn yet.",
      });
      expect(gmail.trashEmail).not.toHaveBeenCalled();
      expect(db.emailDeleteMany).not.toHaveBeenCalled();
    });

    it("trashes a primary-inbox message through Gmail", async () => {
      db.emailFindFirst.mockResolvedValue(PRIMARY_EMAIL);
      gmail.trashEmail.mockResolvedValue({ success: true });

      const app = await buildApp();
      const res = await app.inject({
        method: "DELETE",
        url: "/api/email/e-google",
        headers: auth(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(gmail.trashEmail).toHaveBeenCalledWith("user-1", "gm-1", null);
    });

    it("falls back to local-only removal with a warning when Gmail is not connected", async () => {
      db.emailFindFirst.mockResolvedValue(PRIMARY_EMAIL);
      gmail.trashEmail.mockResolvedValue({ error: "Gmail not connected." });

      const app = await buildApp();
      const res = await app.inject({
        method: "DELETE",
        url: "/api/email/e-google",
        headers: auth(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        success: true,
        warning: "Gmail not connected, removed locally only",
      });
      expect(db.emailDeleteMany).toHaveBeenCalledWith({ where: { id: "e-google" } });
    });
  });

  describe("POST /api/email/:id/archive", () => {
    it("refuses a NAVER-linked message with 501 and writes nothing locally", async () => {
      db.emailFindFirst.mockResolvedValue(NAVER_EMAIL);
      db.linkedFindFirst.mockResolvedValue({ provider: "NAVER" });

      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/email/e-naver/archive",
        headers: auth(),
      });

      expect(res.statusCode).toBe(501);
      expect(res.json()).toEqual({
        error: "This mailbox's provider does not support archive from Klorn yet.",
      });
      expect(gmail.archiveEmail).not.toHaveBeenCalled();
      expect(db.emailDeleteMany).not.toHaveBeenCalled();
    });

    it("archives a GOOGLE-linked message through that account's client", async () => {
      db.emailFindFirst.mockResolvedValue({
        id: "e-linked",
        gmailId: "gm-2",
        linkedInboxAccountId: "acc-google",
      });
      db.linkedFindFirst.mockResolvedValue({ provider: "GOOGLE" });
      gmail.archiveEmail.mockResolvedValue({ success: true });

      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/email/e-linked/archive",
        headers: auth(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(gmail.archiveEmail).toHaveBeenCalledWith("user-1", "gm-2", "acc-google");
    });
  });

  describe("POST /api/email/:id/delete/undo and /archive/undo", () => {
    it.each([
      ["/api/email/e-naver/delete/undo", "restore"],
      ["/api/email/e-naver/archive/undo", "restore"],
    ])("refuses %s with 501 for a NAVER-linked account id", async (url, action) => {
      db.linkedFindFirst.mockResolvedValue({ provider: "NAVER" });

      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url,
        headers: auth(),
        payload: { gmailId: "naver-imap:me@naver.com:42", linkedInboxAccountId: "acc-naver" },
      });

      expect(res.statusCode).toBe(501);
      expect(res.json()).toEqual({
        error: `This mailbox's provider does not support ${action} from Klorn yet.`,
      });
      expect(gmail.untrashEmail).not.toHaveBeenCalled();
      expect(gmail.unarchiveEmail).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /api/email/:id/read", () => {
    it("still updates the local row when the provider has no read surface (divergence tolerated by design)", async () => {
      db.emailFindFirst.mockResolvedValue(NAVER_EMAIL);
      db.linkedFindFirst.mockResolvedValue({ provider: "NAVER" });

      const app = await buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/api/email/e-naver/read",
        headers: auth(),
        payload: { isRead: true },
      });

      expect(res.statusCode).toBe(200);
      expect(gmail.toggleReadGmail).not.toHaveBeenCalled();
      expect(db.emailUpdate).toHaveBeenCalledWith({
        where: { id: "e-naver" },
        data: { isRead: true },
      });
    });

    it("still updates the local row when the provider lookup itself fails (degrade contract)", async () => {
      db.emailFindFirst.mockResolvedValue(NAVER_EMAIL);
      db.linkedFindFirst.mockRejectedValue(new Error("pooler connection dropped"));

      const app = await buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/api/email/e-naver/read",
        headers: auth(),
        payload: { isRead: true },
      });

      expect(res.statusCode).toBe(200);
      expect(db.emailUpdate).toHaveBeenCalledWith({
        where: { id: "e-naver" },
        data: { isRead: true },
      });
    });
  });

  describe("PATCH /api/email/:id/star", () => {
    it("still updates the local row when the provider lookup itself fails (degrade contract)", async () => {
      db.emailFindFirst.mockResolvedValue(NAVER_EMAIL);
      db.linkedFindFirst.mockRejectedValue(new Error("pooler connection dropped"));

      const app = await buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/api/email/e-naver/star",
        headers: auth(),
        payload: { isStarred: true },
      });

      expect(res.statusCode).toBe(200);
      expect(db.emailUpdate).toHaveBeenCalledWith({
        where: { id: "e-naver" },
        data: { isStarred: true },
      });
    });
  });

  describe("a provider failure reaches the client as a code, never as its text", () => {
    /** A googleapis error quoting the request, as gaxios raises it. */
    const providerError = (status: number) =>
      Object.assign(new Error("CANARY-gmail quoted subject"), {
        name: "GaxiosError",
        response: { status, data: { error: { message: "CANARY-gmail", errors: [] } } },
      });

    beforeEach(() => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      db.emailFindFirst.mockResolvedValue(PRIMARY_EMAIL);
    });

    it.each([
      ["DELETE", "/api/email/e-google", "trashEmail", 429, "PROVIDER_RATE_LIMITED", "Delete"],
      [
        "POST",
        "/api/email/e-google/archive",
        "archiveEmail",
        403,
        "PROVIDER_SCOPE_MISSING",
        "Archive",
      ],
      ["POST", "/api/email/gm-1/delete/undo", "untrashEmail", 404, "PROVIDER_NOT_FOUND", "Undo"],
      [
        "POST",
        "/api/email/gm-1/archive/undo",
        "unarchiveEmail",
        503,
        "PROVIDER_UNAVAILABLE",
        "Undo",
      ],
    ] as const)("%s %s: 502 with %s's code", async (method, url, fn, status, code, verb) => {
      gmail[fn].mockRejectedValueOnce(providerError(status));
      const app = await buildApp();
      const res = await app.inject({ method, url, headers: auth(), payload: {} });
      expect(res.statusCode).toBe(502);
      expect(res.body).not.toContain("CANARY");
      const body = res.json();
      expect(body.code).toBe(code);
      expect(body.error).toMatch(new RegExp(`^${verb} failed\\. Your mail provider`));
      await app.close();
    });
  });
});
