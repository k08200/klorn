import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

vi.mock("../email.js", () => ({ sendVerificationEmail: vi.fn(), sendPasswordResetEmail: vi.fn() }));
vi.mock("../gmail.js", () => ({
  getAuthUrl: vi.fn(),
  getLoginAuthUrl: vi.fn(),
  getAuthedClient: vi.fn(),
  getGoogleUserInfo: vi.fn(),
  getOAuth2Client: vi.fn(),
  registerGmailWatch: vi.fn(async () => ({ expiration: Date.now() + 86400000 })),
  stopGmailWatch: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../email-sync.js", () => ({
  syncEmails: vi.fn(async () => ({ synced: 0, newCount: 0, source: "gmail" })),
}));

vi.mock("../db.js", () => {
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({ id: "user-1", plan: "FREE", role: "USER" })),
      findFirst: vi.fn(async ({ where }: { where: { email: { equals: string } } }) => {
        if (where.email.equals === "known@example.com") return { id: "user-1" };
        return null;
      }),
    },
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});

const TOKEN = signToken({ userId: "user-1", email: "t@e.com" });
const auth = () => ({ authorization: `Bearer ${TOKEN}` });

async function buildApp() {
  const { gmailPushRoutes } = await import("../routes/gmail-push.js");
  const app = Fastify();
  await app.register(gmailPushRoutes, { prefix: "/api/gmail" });
  return app;
}

describe("gmail-push routes", () => {
  afterEach(() => {
    delete process.env.GMAIL_PUSH_TOKEN;
  });

  it("returns 503 when push not configured", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/gmail/push" });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("returns 401 for missing push token", async () => {
    process.env.GMAIL_PUSH_TOKEN = "secret";
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/gmail/push",
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 401 for invalid push token", async () => {
    process.env.GMAIL_PUSH_TOKEN = "secret";
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/gmail/push",
      headers: { authorization: "Bearer wrong" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects token passed via query string (must be header)", async () => {
    process.env.GMAIL_PUSH_TOKEN = "secret";
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/gmail/push?token=secret",
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 204 for empty message data", async () => {
    process.env.GMAIL_PUSH_TOKEN = "secret";
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/gmail/push",
      headers: { authorization: "Bearer secret" },
      payload: { message: {} },
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("returns 204 for known user push notification", async () => {
    process.env.GMAIL_PUSH_TOKEN = "secret";
    const app = await buildApp();
    const payload = { emailAddress: "known@example.com", historyId: "12345" };
    const data = Buffer.from(JSON.stringify(payload)).toString("base64");
    const res = await app.inject({
      method: "POST",
      url: "/api/gmail/push",
      headers: { authorization: "Bearer secret" },
      payload: { message: { data } },
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("returns 204 for unknown user (drain subscription)", async () => {
    process.env.GMAIL_PUSH_TOKEN = "secret";
    const app = await buildApp();
    const payload = { emailAddress: "unknown@example.com", historyId: "12345" };
    const data = Buffer.from(JSON.stringify(payload)).toString("base64");
    const res = await app.inject({
      method: "POST",
      url: "/api/gmail/push",
      headers: { authorization: "Bearer secret" },
      payload: { message: { data } },
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("enables gmail watch (authenticated)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/gmail/watch/enable",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("disables gmail watch (authenticated)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/gmail/watch/disable",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
