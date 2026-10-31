/**
 * POST /api/email/:id/unsubscribe — most-automatic-first: RFC 8058
 * one-click (server-side, SSRF-guarded in the module), else a mailto send
 * from the user's own account, else the browser link handed back. Always
 * userId-scoped; an email with no targets is a 400, not a guess.
 */

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

const emailFindFirst = vi.hoisted(() => vi.fn(async () => null as unknown));
const oneClickMock = vi.hoisted(() => vi.fn());
const sendEmailMock = vi.hoisted(() => vi.fn(async () => ({ success: true })));

// The mailto unsubscribe leaves from the user's account; it must be recorded as
// an unsubscribe, never as mail the user wrote to that list.
const recordSentMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
vi.mock("../mail/sent-messages.js", () => ({
  recordSentMessage: recordSentMock,
  waitingOnThreads: vi.fn(async () => []),
  WAITING_ON_DEFAULT_MIN_DAYS: 2,
  syncSentMessages: vi.fn(async () => 0),
}));

vi.mock("../db.js", () => {
  const prisma = {
    userToken: { findFirst: vi.fn(async () => null) },
    emailMessage: {
      findMany: vi.fn(async () => []),
      findFirst: emailFindFirst,
      count: vi.fn(async () => 0),
    },
    attentionItem: { findMany: vi.fn(async () => []) },
    emailRule: { findMany: vi.fn(async () => []) },
    user: { findUnique: vi.fn(async () => ({ id: "user-1", plan: "FREE", role: "USER" })) },
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../billing/entitlement-guard.js", () => ({
  requireEntitled: vi.fn(async () => {}),
  requireAppAccess: vi.fn(async () => {}),
}));
vi.mock("../mail/list-unsubscribe.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../mail/list-unsubscribe.js")>();
  return { ...original, executeOneClickUnsubscribe: oneClickMock };
});
vi.mock("../mail/providers/dispatch.js", () => ({
  mailActionsFor: vi.fn(async () => ({ sendEmail: sendEmailMock })),
  mailActionsForProvider: vi.fn(),
}));

const TOKEN = signToken({ userId: "user-1", email: "t@e.com" });
const auth = () => ({ authorization: `Bearer ${TOKEN}` });

async function buildApp() {
  const { emailRoutes } = await import("../routes/email.js");
  const app = Fastify();
  await app.register(emailRoutes, { prefix: "/api/email" });
  return app;
}

function unsubEmail(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "e1",
    linkedInboxAccountId: null,
    listUnsubscribeMailto: null,
    listUnsubscribeUrl: null,
    listUnsubscribeOneClick: false,
    ...overrides,
  };
}

beforeEach(() => {
  emailFindFirst.mockReset();
  emailFindFirst.mockResolvedValue(null);
  oneClickMock.mockReset();
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue({ success: true });
});

describe("POST /api/email/:id/unsubscribe", () => {
  it("404s an unowned email and 400s one with no targets", async () => {
    const app = await buildApp();
    const missing = await app.inject({
      method: "POST",
      url: "/api/email/nope/unsubscribe",
      headers: auth(),
    });
    expect(missing.statusCode).toBe(404);
    emailFindFirst.mockResolvedValue(unsubEmail());
    const none = await app.inject({
      method: "POST",
      url: "/api/email/e1/unsubscribe",
      headers: auth(),
    });
    expect(none.statusCode).toBe(400);
    await app.close();
  });

  it("performs the RFC 8058 POST when one-click is available", async () => {
    emailFindFirst.mockResolvedValue(
      unsubEmail({ listUnsubscribeUrl: "https://x.com/u", listUnsubscribeOneClick: true }),
    );
    oneClickMock.mockResolvedValue({ ok: true });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/e1/unsubscribe",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ method: "one-click", done: true });
    expect(oneClickMock).toHaveBeenCalledWith("https://x.com/u");
    await app.close();
  });

  it("falls back to a mailto send when one-click fails", async () => {
    emailFindFirst.mockResolvedValue(
      unsubEmail({
        listUnsubscribeUrl: "https://x.com/u",
        listUnsubscribeOneClick: true,
        listUnsubscribeMailto: "mailto:unsub@lists.x.com?subject=stop",
      }),
    );
    oneClickMock.mockResolvedValue({ ok: false, reason: "http-503" });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/e1/unsubscribe",
      headers: auth(),
    });
    expect(res.json()).toEqual({ method: "mailto", done: true });
    expect(sendEmailMock).toHaveBeenCalledWith(
      "user-1",
      "unsub@lists.x.com",
      "stop",
      "unsubscribe",
      [],
      expect.objectContaining({ linkedInboxAccountId: null }),
    );
    await app.close();
  });

  it("records a sent mailto unsubscribe with origin unsubscribe", async () => {
    recordSentMock.mockClear();
    emailFindFirst.mockResolvedValue(
      unsubEmail({ listUnsubscribeMailto: "mailto:unsub@lists.x.com?subject=stop" }),
    );
    sendEmailMock.mockResolvedValueOnce({
      success: true,
      messageId: "gm-7",
      threadId: "th-7",
    } as never);
    const app = await buildApp();
    await app.inject({ method: "POST", url: "/api/email/e1/unsubscribe", headers: auth() });
    expect(recordSentMock).toHaveBeenCalledWith("user-1", {
      gmailId: "gm-7",
      threadId: "th-7",
      to: "unsub@lists.x.com",
      subject: "stop",
      sentAt: expect.any(Date),
      inbox: "primary",
      origin: "unsubscribe",
    });
    await app.close();
  });

  it("hands the browser link back when nothing automatic is possible", async () => {
    emailFindFirst.mockResolvedValue(unsubEmail({ listUnsubscribeUrl: "http://x.com/u" }));
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/e1/unsubscribe",
      headers: auth(),
    });
    expect(res.json()).toEqual({ method: "link", done: false, url: "http://x.com/u" });
    expect(oneClickMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("502s when a mailto-only email cannot be sent", async () => {
    emailFindFirst.mockResolvedValue(unsubEmail({ listUnsubscribeMailto: "mailto:u@x.com" }));
    sendEmailMock.mockResolvedValue({ error: "Gmail not connected." });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/e1/unsubscribe",
      headers: auth(),
    });
    expect(res.statusCode).toBe(502);
    await app.close();
  });
});
