import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";
import { mintTierOverrideToken } from "../billing/tier-override-token.js";
import { mintPushLaterToken } from "../notify/push-later-token.js";

// Set before importing push-origin-allowlist (loaded transitively via routes).
process.env.PUSH_ALLOWED_ORIGINS = "https://app.klorn.ai,http://localhost:8001";

vi.mock("../mail/email.js", () => ({
  sendVerificationEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
}));
vi.mock("../mail/gmail.js", () => ({
  getAuthUrl: vi.fn(),
  getLoginAuthUrl: vi.fn(),
  getAuthedClient: vi.fn(),
  getGoogleUserInfo: vi.fn(),
  getOAuth2Client: vi.fn(),
}));
vi.mock("../background.js", () => ({
  getNotifications: vi.fn(async () => [
    { id: "n1", type: "info", title: "Test", message: "msg", isRead: false },
  ]),
  markNotificationRead: vi.fn(async () => {}),
  markAllNotificationsRead: vi.fn(async () => {}),
  clearNotifications: vi.fn(async () => {}),
}));
vi.mock("../notify/push.js", () => ({
  getVapidPublicKey: vi.fn(() => "test-vapid-key"),
  sendPushNotification: vi.fn(async () => ({
    status: "sent",
    subscriptions: 1,
    attempted: 1,
    accepted: 1,
    failed: 0,
  })),
}));
vi.mock("../notify/push-device.js", () => ({
  sendDevicePush: vi.fn(async () => ({
    status: "sent",
    tokens: 1,
    accepted: 1,
    failed: 0,
  })),
}));
const remindLaterFromPush = vi.hoisted(() =>
  vi.fn(async (grant: { userId: string; emailId: string }) =>
    grant.userId === "user-1" && grant.emailId === "email-1"
      ? { ok: true as const, created: true }
      : { ok: false as const },
  ),
);
vi.mock("../notify/push-later.js", () => ({ remindLaterFromPush }));
const labelUpdateMany = vi.hoisted(() => vi.fn(async (_args: unknown) => ({ count: 1 })));
vi.mock("../notify/push-delivery.js", () => ({
  recordPushReceipt: vi.fn(async () => true),
  getPushDeliveryStats: vi.fn(async () => ({
    since: "2026-04-28T00:00:00.000Z",
    total: 1,
    accepted: 1,
    failed: 0,
    skipped: 0,
    received: 1,
    clicked: 0,
    receiptRate: 1,
    clickRate: 0,
    recent: [],
  })),
}));

const desktopCatchUp = vi.hoisted(() =>
  vi.fn(async (_userId: string, ids: string[]) => ({
    held: false,
    summaryTitle: "{count} urgent emails while Klorn was closed",
    items: ids.map((id) => ({ id, emailId: "email-1", title: "Kim", body: "s", createdAt: "x" })),
  })),
);
vi.mock("../notify/desktop-catchup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../notify/desktop-catchup.js")>()),
  desktopCatchUp,
}));

vi.mock("../db.js", () => {
  const prisma = {
    notification: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id === "n1") return { id: "n1", userId: "user-1", isRead: false };
        return null;
      }),
    },
    pushSubscription: {
      upsert: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({})),
    },
    devicePushToken: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({})),
    },
    user: { findUnique: vi.fn(async () => ({ id: "user-1", plan: "FREE", role: "USER" })) },
    device: {
      findUnique: vi.fn(async () => ({ id: "d1" })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
    attentionItem: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) => {
        if (where.id === "item-1" && where.userId === "user-1") {
          return { id: "item-1", source: "EMAIL", sourceId: "email-1" };
        }
        return null;
      }),
      update: vi.fn(async () => ({})),
    },
    // The tier-override stamp and a push Later's SNOOZED stamp both land here.
    decisionLabel: { updateMany: labelUpdateMany },
    // overrideAttentionTier wraps the tier write + ledger stamp in one
    // prisma.$transaction (batch form since the 2026-07-16 P2028 fix). Support
    // both forms: settle an operation array, or run a callback with this mock
    // as the tx client.
    $transaction: vi.fn(async (arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => unknown)(prisma),
    ),
  };
  return { prisma, db: prisma };
});

const TOKEN = signToken({ userId: "user-1", email: "t@e.com" });
const OTHER = signToken({ userId: "user-2", email: "o@e.com" });
const auth = (t = TOKEN) => ({ authorization: `Bearer ${t}` });

async function buildApp() {
  const { notificationRoutes } = await import("../routes/notifications.js");
  const app = Fastify();
  await app.register(notificationRoutes, { prefix: "/api/notifications" });
  return app;
}

describe("GET /api/notifications/desktop-catchup (decision N6)", () => {
  it("needs a session", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/notifications/desktop-catchup?ids=a",
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("asks about the signed-in user's ids only", async () => {
    desktopCatchUp.mockClear();
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/notifications/desktop-catchup?ids=n1,n2",
      headers: auth(OTHER),
    });
    expect(res.statusCode).toBe(200);
    expect(desktopCatchUp).toHaveBeenCalledWith("user-2", ["n1", "n2"]);
    expect(res.json().items.map((i: { id: string }) => i.id)).toEqual(["n1", "n2"]);
    await app.close();
  });

  it("rejects a malformed id list with 400 and reads nothing", async () => {
    desktopCatchUp.mockClear();
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/notifications/desktop-catchup?ids=a%3Bb",
      headers: auth(),
    });
    expect(res.statusCode).toBe(400);
    expect(desktopCatchUp).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("notification routes", () => {
  it("rejects unauthenticated with 401", async () => {
    const app = await buildApp();
    expect((await app.inject({ method: "GET", url: "/api/notifications" })).statusCode).toBe(401);
    await app.close();
  });

  it("lists notifications", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/notifications", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().notifications).toHaveLength(1);
    expect(res.json()).toHaveProperty("unread");
    await app.close();
  });

  it("marks notification as read", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/notifications/n1/read",
      headers: auth(),
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("returns 403 for other user's notification", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/notifications/n1/read",
      headers: auth(OTHER),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("marks all as read", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/notifications/read-all",
      headers: auth(),
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("clears all notifications", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: "/api/notifications", headers: auth() });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("returns VAPID public key", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/notifications/vapid-key",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().publicKey).toBe("test-vapid-key");
    await app.close();
  });

  it("records push receipts without auth", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/receipts/delivery-1",
      payload: { event: "received" },
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("records an action button as actioned with its name", async () => {
    const { recordPushReceipt } = await import("../notify/push-delivery.js");
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/receipts/delivery-1",
      payload: { event: "actioned", action: "later" },
    });
    expect(res.statusCode).toBe(204);
    expect(recordPushReceipt).toHaveBeenCalledWith(
      "delivery-1",
      "actioned",
      expect.any(Date),
      "later",
    );
    await app.close();
  });

  it("rejects actioned without a known action, and an action on any other event", async () => {
    const app = await buildApp();
    for (const payload of [
      { event: "actioned" },
      { event: "actioned", action: "mute" },
      { event: "clicked", action: "later" },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/notifications/push/receipts/delivery-1",
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });

  it("rejects invalid push receipt events", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/receipts/delivery-1",
      payload: { event: "opened" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("registers push subscription with valid HTTPS endpoint and allowed origin", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/subscribe",
      headers: auth(),
      payload: {
        endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
        keys: { p256dh: "key1", auth: "key2" },
        origin: "https://app.klorn.ai",
      },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it("stores the subscribing browser and OS (derived, never the raw user agent)", async () => {
    const { prisma } = await import("../db.js");
    vi.mocked(prisma.pushSubscription.upsert).mockClear();
    const app = await buildApp();
    const ua =
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/subscribe",
      headers: { ...auth(), "user-agent": ua },
      payload: {
        endpoint: "https://fcm.googleapis.com/fcm/send/android-1",
        keys: { p256dh: "key1", auth: "key2" },
        origin: "https://app.klorn.ai",
      },
    });
    expect(res.statusCode).toBe(201);
    const arg = vi.mocked(prisma.pushSubscription.upsert).mock.calls[0][0];
    expect(arg.create).toMatchObject({ browser: "chrome", os: "android" });
    expect(arg.update).toMatchObject({ browser: "chrome", os: "android" });
    expect(JSON.stringify(arg)).not.toContain("Pixel 8");
    await app.close();
  });

  it("prunes this browser's prior + legacy rows when subscribing with a deviceId", async () => {
    const { prisma } = await import("../db.js");
    vi.mocked(prisma.pushSubscription.deleteMany).mockClear();
    vi.mocked(prisma.pushSubscription.upsert).mockClear();
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/subscribe",
      headers: auth(),
      payload: {
        endpoint: "https://fcm.googleapis.com/fcm/send/rotated-new",
        keys: { p256dh: "k1", auth: "k2" },
        origin: "https://app.klorn.ai",
        deviceId: "browser-xyz",
      },
    });
    expect(res.statusCode).toBe(201);
    // Deletes this device's other endpoints + legacy (null-device) rows on the
    // same origin, never the row we're upserting, never another user's rows.
    expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        endpoint: { not: "https://fcm.googleapis.com/fcm/send/rotated-new" },
        OR: [{ deviceId: "browser-xyz" }, { deviceId: null, origin: "https://app.klorn.ai" }],
      },
    });
    // And the surviving row carries the deviceId so future rotations can dedupe.
    expect(prisma.pushSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ deviceId: "browser-xyz" }) }),
    );
    await app.close();
  });

  it("does NOT prune when subscribing without a deviceId (legacy client)", async () => {
    const { prisma } = await import("../db.js");
    vi.mocked(prisma.pushSubscription.deleteMany).mockClear();
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/subscribe",
      headers: auth(),
      payload: {
        endpoint: "https://fcm.googleapis.com/fcm/send/legacy",
        keys: { p256dh: "k1", auth: "k2" },
        origin: "https://app.klorn.ai",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(prisma.pushSubscription.deleteMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects push subscribe from a non-allowlisted origin", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/subscribe",
      headers: auth(),
      payload: {
        endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
        keys: { p256dh: "k1", auth: "k2" },
        origin: "https://hire-eve-web.vercel.app",
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects push subscribe with HTTP endpoint", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/subscribe",
      headers: auth(),
      payload: {
        endpoint: "http://insecure.example.com/push",
        keys: { p256dh: "k1", auth: "k2" },
        origin: "https://app.klorn.ai",
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects push subscribe with localhost (SSRF)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/subscribe",
      headers: auth(),
      payload: {
        endpoint: "https://localhost:3000/push",
        keys: { p256dh: "k1", auth: "k2" },
        origin: "https://app.klorn.ai",
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("unsubscribes push", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/notifications/push/unsubscribe",
      headers: auth(),
      payload: { endpoint: "https://fcm.googleapis.com/fcm/send/abc" },
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("returns push delivery stats", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/notifications/push/delivery-stats?hours=24&limit=10",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: 1, received: 1, receiptRate: 1 });
    await app.close();
  });

  it("registers a native device push token", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/device-token/register",
      headers: auth(),
      payload: { token: "fcm-token-abc123", platform: "android" },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it("stores dataMessages only for an Android build that sends it", async () => {
    const { prisma } = await import("../db.js");
    const upsert = prisma.devicePushToken.upsert as unknown as ReturnType<typeof vi.fn>;
    const app = await buildApp();
    const cases: Array<[Record<string, unknown>, boolean]> = [
      [{ token: "fcm-token-abc123", platform: "android", dataMessages: true }, true],
      [{ token: "fcm-token-abc123", platform: "android", dataMessages: false }, false],
      [{ token: "fcm-token-abc123", platform: "android" }, false],
      [{ token: "a".repeat(64), platform: "ios", dataMessages: true }, false],
    ];
    for (const [payload, stored] of cases) {
      upsert.mockClear();
      const res = await app.inject({
        method: "POST",
        url: "/api/notifications/push/device-token/register",
        headers: auth(),
        payload,
      });
      expect(res.statusCode).toBe(201);
      const call = upsert.mock.calls[0]?.[0] as {
        create: { dataMessages: boolean };
        update: { dataMessages: boolean };
      };
      expect(call.create.dataMessages).toBe(stored);
      // Re-registration overwrites it: a downgraded build falls back on its next launch.
      expect(call.update.dataMessages).toBe(stored);
    }
    await app.close();
  });

  it("rejects a non-boolean dataMessages", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/device-token/register",
      headers: auth(),
      payload: { token: "fcm-token-abc123", platform: "android", dataMessages: "yes" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects device token register with an invalid platform", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/device-token/register",
      headers: auth(),
      payload: { token: "fcm-token-abc123", platform: "windows" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects device token register with a missing/garbage token", async () => {
    const app = await buildApp();
    const missing = await app.inject({
      method: "POST",
      url: "/api/notifications/push/device-token/register",
      headers: auth(),
      payload: { platform: "ios" },
    });
    expect(missing.statusCode).toBe(400);

    const garbage = await app.inject({
      method: "POST",
      url: "/api/notifications/push/device-token/register",
      headers: auth(),
      payload: { token: "has spaces & symbols!", platform: "ios" },
    });
    expect(garbage.statusCode).toBe(400);
    await app.close();
  });

  it("requires auth to register a device token", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/device-token/register",
      payload: { token: "fcm-token-abc123", platform: "android" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("unregisters a native device push token", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/notifications/push/device-token",
      headers: auth(),
      payload: { token: "fcm-token-abc123" },
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("sends a native device test push", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/device-test",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sent: true });
    await app.close();
  });

  // ── one-tap tier override (public capability endpoint) ──────────────────
  it("applies a tier override from a valid capability token WITHOUT a session", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/tier-override",
      // No auth header — the signed token is the only credential.
      payload: { token: mintTierOverrideToken("user-1", "item-1"), tier: "QUEUE" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, tier: "QUEUE" });
    await app.close();
  });

  it("rejects a garbage override token with 401", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/tier-override",
      payload: { token: "not-a-real-token", tier: "QUEUE" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a non-reversible tier (PUSH) — token is not permitted to apply it (403)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/tier-override",
      payload: { token: mintTierOverrideToken("user-1", "item-1"), tier: "PUSH" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("rejects a malformed tier (non-string) with 400", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/tier-override",
      payload: { token: mintTierOverrideToken("user-1", "item-1"), tier: 123 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns 404 when the token's item does not belong to the user", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/tier-override",
      payload: { token: mintTierOverrideToken("user-1", "missing-item"), tier: "SILENT" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  // ── "Later" from a web push action (public capability endpoint) ─────────
  it("sets the Later reminder from a valid capability token WITHOUT a session", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/later",
      payload: { token: mintPushLaterToken("user-1", "email-1") },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(remindLaterFromPush).toHaveBeenLastCalledWith({ userId: "user-1", emailId: "email-1" });
    await app.close();
  });

  it("rejects a garbage, missing or wrong-kind Later token with 400/401 and writes nothing", async () => {
    const app = await buildApp();
    remindLaterFromPush.mockClear();
    const bad = await app.inject({
      method: "POST",
      url: "/api/notifications/push/later",
      payload: { token: "not-a-real-token" },
    });
    expect(bad.statusCode).toBe(401);
    // A tier-override token is a different capability: refused here.
    const wrongKind = await app.inject({
      method: "POST",
      url: "/api/notifications/push/later",
      payload: { token: mintTierOverrideToken("user-1", "item-1") },
    });
    expect(wrongKind.statusCode).toBe(401);
    // A session JWT is not a Later capability either.
    const session = await app.inject({
      method: "POST",
      url: "/api/notifications/push/later",
      payload: { token: TOKEN },
    });
    expect(session.statusCode).toBe(401);
    const missing = await app.inject({
      method: "POST",
      url: "/api/notifications/push/later",
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
    expect(remindLaterFromPush).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 404 when the token's mail is not the token user's", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/later",
      payload: { token: mintPushLaterToken("user-1", "email-2") },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("POST /api/notifications/push/later — decision ledger", () => {
  const pushLater = async (token: string) => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/push/later",
      payload: { token },
    });
    await app.close();
    await new Promise((r) => setTimeout(r, 0));
    return res;
  };

  it("stamps SNOOZED once on the token user's mail", async () => {
    labelUpdateMany.mockClear();
    const res = await pushLater(mintPushLaterToken("user-1", "email-1"));

    expect(res.statusCode).toBe(200);
    expect(labelUpdateMany.mock.calls.map((c) => c[0])).toEqual([
      {
        where: { userId: "user-1", source: "EMAIL", sourceId: "email-1", snoozedAt: null },
        data: { snoozedAt: expect.any(Date) },
      },
    ]);
  });

  it("stamps nothing for a bad token or a mail that isn't the token user's", async () => {
    labelUpdateMany.mockClear();
    const bad = await pushLater("not-a-real-token");
    const foreign = await pushLater(mintPushLaterToken("user-1", "email-2"));

    expect([bad.statusCode, foreign.statusCode]).toEqual([401, 404]);
    expect(labelUpdateMany).not.toHaveBeenCalled();
  });

  it("answers exactly the same when the ledger write fails", async () => {
    labelUpdateMany.mockResolvedValueOnce({ count: 1 });
    const ok = await pushLater(mintPushLaterToken("user-1", "email-1"));
    labelUpdateMany.mockRejectedValueOnce(new Error("ledger down"));
    const failed = await pushLater(mintPushLaterToken("user-1", "email-1"));

    expect(failed.statusCode).toBe(ok.statusCode);
    expect(failed.body).toBe(ok.body);
  });
});
