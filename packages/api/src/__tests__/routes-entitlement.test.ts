/**
 * Entitlement-wiring regression guard for the usable free tier.
 *
 * A CRITICAL slipped through here once: when the parent email plugin moved from
 * requireEntitled → requireAppAccess (to let free users read/triage mail), the
 * `POST /api/email/send` and `/compose` routes lost their only entitlement
 * gate — a free token could send mail through the user's Gmail. The existing
 * 1700+ unit tests never caught it because it was a route-wiring gap, not a
 * logic bug.
 *
 * These tests boot the REAL email-mutations routes with the REAL guards under
 * PAYWALL_ENABLED=true, mirroring routes/email.ts's exact wiring, and pin the
 * split: paid mutations (send/compose) 403 for free; reversible actions (mark
 * read) don't — which also proves requireAppAccess admits free users.
 */

import Fastify from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ plan: "FREE", role: "USER" }));

vi.mock("../db.js", () => {
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({ id: "user-1", plan: state.plan, role: state.role })),
    },
    emailMessage: {
      findFirst: vi.fn(async () => ({ id: "e1", gmailId: "g1", userId: "user-1", isRead: false })),
      update: vi.fn(async () => ({ id: "e1" })),
    },
    // requireAuth checks isDeviceSessionValid; an empty device list is the
    // "legacy session, allow through" path so the real guard admits the token.
    device: {
      findUnique: vi.fn(async () => ({ id: "device-1" })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../email-sync.js", () => ({ syncEmailByGmailId: vi.fn(async () => ({})) }));
vi.mock("../gmail.js", () => ({
  sendEmail: vi.fn(async () => ({ id: "sent-1" })),
  archiveEmail: vi.fn(async () => ({})),
  toggleReadGmail: vi.fn(async () => ({})),
  toggleStarGmail: vi.fn(async () => ({})),
  trashEmail: vi.fn(async () => ({})),
  unarchiveEmail: vi.fn(async () => ({})),
  untrashEmail: vi.fn(async () => ({})),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const ORIGINAL_PAYWALL = process.env.PAYWALL_ENABLED;

// Boot the paywall ON so config + guards evaluate against it, and register the
// email-mutations sub-routes under the SAME parent hooks routes/email.ts uses.
async function buildApp() {
  process.env.PAYWALL_ENABLED = "true";
  vi.resetModules();
  const { signToken, requireAuth } = await import("../auth.js");
  const { requireAppAccess } = await import("../entitlement-guard.js");
  const { registerEmailMutationsRoutes } = await import("../routes/email-mutations.js");
  const app = Fastify();
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", requireAppAccess);
  await app.register(registerEmailMutationsRoutes, { prefix: "/api/email" });
  await app.ready();
  const token = signToken({ userId: "user-1", email: "test@example.com" });
  return { app, headers: { authorization: `Bearer ${token}` } };
}

beforeEach(() => {
  state.plan = "FREE";
  state.role = "USER";
});

afterAll(() => {
  if (ORIGINAL_PAYWALL === undefined) delete process.env.PAYWALL_ENABLED;
  else process.env.PAYWALL_ENABLED = ORIGINAL_PAYWALL;
  vi.resetModules();
});

describe("email entitlement wiring (PAYWALL_ENABLED=true)", () => {
  it("403s a FREE user on POST /send — sending is email_write (Pro)", async () => {
    const { app, headers } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/send",
      headers,
      payload: { to: "x@y.com", subject: "hi", body: "hello" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("ENTITLEMENT_REQUIRED");
    await app.close();
  });

  it("403s a FREE user on POST /compose — compose+send is email_write (Pro)", async () => {
    const { app, headers } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/compose",
      headers,
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("lets a PRO user past the send entitlement gate (not 403)", async () => {
    state.plan = "PRO";
    const { app, headers } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/email/send",
      headers,
      payload: { to: "x@y.com", subject: "hi", body: "hello" },
    });
    // Past the gate → real handler (sendEmail mocked) → 200, not a 403 wall.
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("lets a FREE user mark-read — reversible action stays free, and requireAppAccess admits them", async () => {
    const { app, headers } = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/email/e1/read",
      headers,
      payload: { isRead: true },
    });
    // 200 (not 403): proves the free tier is not hard-walled at the app-access
    // gate AND that reversible mutations are not Pro-gated.
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
