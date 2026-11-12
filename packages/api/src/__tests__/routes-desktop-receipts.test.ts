// POST /api/notifications/desktop/receipts — the Mac / Windows apps report
// that a banner was shown, clicked, or actioned. Pins: session auth, a strict
// body schema, ownership (someone else's id is a 404), idempotency at the
// writer, and a per-user rate limit.
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

const mocks = vi.hoisted(() => ({
  recordDesktopReceipt: vi.fn(async () => "recorded"),
}));

vi.mock("../db.js", () => {
  const prisma = {
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      update: vi.fn(async () => ({})),
    },
    user: { findUnique: vi.fn(async () => ({ id: "user-1" })) },
  };
  return { prisma, db: prisma };
});
vi.mock("../notify/channel-delivery-log.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../notify/channel-delivery-log.js")>();
  return { ...real, recordDesktopReceipt: mocks.recordDesktopReceipt };
});

const TOKEN = signToken({ userId: "user-1", email: "t@e.com" });
const auth = { authorization: `Bearer ${TOKEN}` };
const URL = "/api/notifications/desktop/receipts";
const ID = "11111111-2222-4333-8444-555555555555";
const BODY = { app: "mac", event: "shown", kind: "attention_item", id: ID };

async function buildApp(opts: { withRateLimit?: boolean } = {}) {
  const { desktopReceiptRoutes } = await import("../routes/desktop-receipts.js");
  const app = Fastify();
  if (opts.withRateLimit) await app.register(rateLimit, { max: 1000, timeWindow: "1 minute" });
  await app.register(desktopReceiptRoutes, { prefix: URL });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.recordDesktopReceipt.mockResolvedValue("recorded");
});

describe("POST desktop receipts", () => {
  it("rejects an unauthenticated caller", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: URL, payload: BODY });
    expect(res.statusCode).toBe(401);
    expect(mocks.recordDesktopReceipt).not.toHaveBeenCalled();
  });

  it("records a report for the caller and answers 204", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: URL, headers: auth, payload: BODY });
    expect(res.statusCode).toBe(204);
    expect(mocks.recordDesktopReceipt).toHaveBeenCalledWith({
      userId: "user-1",
      app: "mac",
      event: "shown",
      kind: "attention_item",
      id: ID,
    });
  });

  it("passes an action button through for an actioned report", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: URL,
      headers: auth,
      payload: {
        ...BODY,
        app: "windows",
        event: "actioned",
        kind: "notification",
        action: "reply",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(mocks.recordDesktopReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ app: "windows", event: "actioned", action: "reply" }),
    );
  });

  it("answers 404 for an id that is not the caller's own", async () => {
    mocks.recordDesktopReceipt.mockResolvedValue("not_found");
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: URL, headers: auth, payload: BODY });
    expect(res.statusCode).toBe(404);
  });

  it.each([
    ["an unknown app", { ...BODY, app: "linux" }],
    ["an unknown event", { ...BODY, event: "delivered" }],
    ["an unknown kind", { ...BODY, kind: "email" }],
    ["a non-uuid id", { ...BODY, id: "../../etc" }],
    ["an unknown action", { ...BODY, event: "actioned", action: "mute" }],
    ["actioned without an action", { ...BODY, event: "actioned" }],
    ["an action on a plain click", { ...BODY, event: "clicked", action: "later" }],
  ])("rejects %s with 400", async (_label, payload) => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: URL, headers: auth, payload });
    expect(res.statusCode).toBe(400);
    expect(mocks.recordDesktopReceipt).not.toHaveBeenCalled();
  });

  it("never takes the user from the body: it is always the session's", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: URL,
      headers: auth,
      payload: { ...BODY, userId: "user-2" },
    });
    expect(res.statusCode).toBe(204);
    expect(mocks.recordDesktopReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
    );
  });

  it("rate-limits per user", async () => {
    const { DESKTOP_RECEIPT_RATE_LIMIT } = await import("../routes/desktop-receipts.js");
    const app = await buildApp({ withRateLimit: true });
    const send = () => app.inject({ method: "POST", url: URL, headers: auth, payload: BODY });
    for (let i = 0; i < DESKTOP_RECEIPT_RATE_LIMIT.max; i++) {
      expect((await send()).statusCode).toBe(204);
    }
    const limited = await send();
    expect(limited.statusCode).toBe(429);
  });
});
