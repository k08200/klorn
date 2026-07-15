import type { FastifyInstance } from "fastify";
import { overrideAttentionTier } from "../attention-override.js";
import { getUserId, requireAuth } from "../auth.js";
import {
  clearNotifications,
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "../background.js";
import { verifyTierOverrideToken } from "../billing/tier-override-token.js";
import { prisma } from "../db.js";
import { getVapidPublicKey, sendPushNotification } from "../notify/push.js";
import { getPushDeliveryStats, recordPushReceipt } from "../notify/push-delivery.js";
import { sendDevicePush } from "../notify/push-device.js";
import { isAllowedPushOrigin } from "../notify/push-origin-allowlist.js";
import type { Tier } from "../tiers.js";

export async function notificationRoutes(app: FastifyInstance) {
  // POST /api/notifications/push/receipts/:deliveryId — public, high-entropy
  // receipt from the service worker (which has no session cookie). The 128-bit
  // deliveryId IS the capability: it is only ever delivered inside the recipient's
  // own push payload, and the write is a one-way, idempotent flag flip (received/
  // clicked) that returns no user data. Rate-limited like the sibling
  // tier-override endpoint so a leaked id can't be used to hammer receipt writes.
  app.post(
    "/push/receipts/:deliveryId",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { deliveryId } = request.params as { deliveryId: string };
      const { event } = (request.body || {}) as { event?: "received" | "clicked" };
      if (event !== "received" && event !== "clicked") {
        return reply.code(400).send({ error: "Invalid receipt event" });
      }
      await recordPushReceipt(deliveryId, event);
      return reply.code(204).send();
    },
  );

  // POST /api/notifications/push/tier-override — public, capability-authenticated
  // one-tap retier from a push notification action button ("Later" → QUEUE,
  // "Mute" → SILENT). The signed token (NOT a session cookie — the service
  // worker has none) is the authorization; it is scoped to exactly one
  // (userId, itemId). Only the safe, reversible tiers are accepted here, so a
  // capability can never escalate an item to PUSH/AUTO.
  app.post(
    "/push/tier-override",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { token, tier } = (request.body || {}) as { token?: string; tier?: string };
      if (typeof token !== "string" || typeof tier !== "string") {
        return reply.code(400).send({ error: "Invalid override request" });
      }
      const grant = verifyTierOverrideToken(token);
      if (!grant) {
        return reply.code(401).send({ error: "Invalid or expired token" });
      }
      // Tier is enforced from the TOKEN's permitted set, not just a route
      // allowlist — a capability can only ever apply what it was minted for.
      if (!grant.tiers.includes(tier)) {
        return reply.code(403).send({ error: "Token not permitted to apply this tier" });
      }
      const result = await overrideAttentionTier(grant.userId, grant.itemId, tier as Tier);
      if (!result.ok) {
        return reply.code(404).send({ error: "Attention item not found" });
      }
      return reply.code(200).send({ ok: true, tier: result.tier });
    },
  );

  app.addHook("preHandler", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    if (
      path.startsWith("/push/receipts/") ||
      path.startsWith("/api/notifications/push/receipts/") ||
      // One-tap tier override from a notification action: authenticated by the
      // signed capability token in the body, not a session (the SW has none).
      path.startsWith("/push/tier-override") ||
      path.startsWith("/api/notifications/push/tier-override") ||
      // The SW's pushsubscriptionchange handler has no auth token; the
      // rotate route authenticates by matching the OLD endpoint (a
      // high-entropy capability URL) against an existing row instead.
      path.startsWith("/push/rotate") ||
      path.startsWith("/api/notifications/push/rotate")
    ) {
      return;
    }
    return requireAuth(request, reply);
  });

  // GET /api/notifications — Get notifications (supports ?unread=true&limit=50)
  app.get("/", async (request) => {
    const userId = getUserId(request);
    const { unread, limit } = request.query as { unread?: string; limit?: string };
    const notifs = await getNotifications(userId, {
      unreadOnly: unread === "true",
      limit: limit ? Number.parseInt(limit, 10) : 50,
    });
    return {
      notifications: notifs,
      count: notifs.length,
      unread: notifs.filter((n) => !n.isRead).length,
    };
  });

  // PATCH /api/notifications/:id/read — Mark single notification as read
  app.patch("/:id/read", async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };
    const notif = await prisma.notification.findUnique({ where: { id } });
    if (!notif) return reply.code(404).send({ error: "Notification not found" });
    if (notif.userId !== userId) return reply.code(403).send({ error: "Forbidden" });
    await markNotificationRead(id);
    return reply.code(204).send();
  });

  // PATCH /api/notifications/read-all — Mark all as read
  app.patch("/read-all", async (request, reply) => {
    const userId = getUserId(request);
    await markAllNotificationsRead(userId);
    return reply.code(204).send();
  });

  // DELETE /api/notifications — Clear all notifications
  app.delete("/", async (request, reply) => {
    const userId = getUserId(request);
    await clearNotifications(userId);
    return reply.code(204).send();
  });

  // GET /api/notifications/vapid-key — Get public VAPID key for push subscription
  app.get("/vapid-key", async () => {
    return { publicKey: getVapidPublicKey() };
  });

  // POST /api/notifications/push/subscribe — Register push subscription
  app.post("/push/subscribe", async (request, reply) => {
    const userId = getUserId(request);
    const {
      endpoint,
      keys,
      origin: bodyOrigin,
    } = request.body as {
      endpoint: string;
      keys: { p256dh: string; auth: string };
      origin?: string;
    };

    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return reply.code(400).send({ error: "Invalid push subscription" });
    }

    // The SW's web origin determines where a notificationclick openWindow()
    // lands. Reject subs whose origin is not in the current allowlist so we
    // never silently keep delivering to a retired domain (see
    // push-origin-allowlist.ts).
    const claimedOrigin = bodyOrigin || (request.headers.origin as string | undefined);
    if (!claimedOrigin || !isAllowedPushOrigin(claimedOrigin)) {
      return reply.code(400).send({ error: "Push subscription origin not allowed" });
    }
    const normalizedOrigin = new URL(claimedOrigin).origin;

    const endpointError = validatePushEndpointUrl(endpoint);
    if (endpointError) {
      return reply.code(400).send({ error: endpointError });
    }

    const safeEndpointForLog = endpoint.replace(/[\r\n]/g, "").slice(0, 60);
    console.log(
      `[PUSH-SUB] Registering push subscription for user ${userId}: ${safeEndpointForLog}...`,
    );
    await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: {
        userId,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        origin: normalizedOrigin,
      },
      update: {
        userId,
        p256dh: keys.p256dh,
        auth: keys.auth,
        origin: normalizedOrigin,
      },
    });
    console.log(`[PUSH-SUB] Successfully registered push subscription for user ${userId}`);

    return reply.code(201).send({ success: true });
  });

  // POST /api/notifications/push/rotate — Swap a rotated subscription.
  // Called by the service worker's pushsubscriptionchange handler, which has
  // no auth token. The OLD endpoint is the credential: it is an unguessable
  // capability URL that must match an existing row. Rows are only ever
  // UPDATED in place (same user, same origin) — this route can never create
  // a subscription for an attacker-chosen user.
  app.post("/push/rotate", async (request, reply) => {
    const { oldEndpoint, endpoint, keys } = request.body as {
      oldEndpoint?: string;
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    };
    if (!oldEndpoint || !endpoint || !keys?.p256dh || !keys?.auth) {
      return reply.code(400).send({ error: "Invalid rotate payload" });
    }
    const endpointError = validatePushEndpointUrl(endpoint);
    if (endpointError) {
      return reply.code(400).send({ error: endpointError });
    }

    const existing = await prisma.pushSubscription.findUnique({
      where: { endpoint: oldEndpoint },
      select: { id: true, userId: true },
    });
    if (!existing) {
      // Unknown old endpoint — nothing to rotate (and nothing to leak).
      return reply.code(404).send({ error: "Unknown subscription" });
    }

    // The new endpoint may already exist (double-fired event) — clear it
    // first so the unique constraint can't fail the swap.
    await prisma.pushSubscription.deleteMany({
      where: { endpoint, id: { not: existing.id } },
    });
    await prisma.pushSubscription.update({
      where: { id: existing.id },
      data: { endpoint, p256dh: keys.p256dh, auth: keys.auth },
    });
    console.log(`[PUSH-SUB] Rotated subscription for user ${existing.userId}`);
    return reply.code(204).send();
  });

  // POST /api/notifications/push/test — Send a test push notification
  app.post("/push/test", async (request) => {
    const userId = getUserId(request);
    const result = await sendPushNotification(userId, {
      title: "Klorn test",
      body: "Push notifications are working.",
      url: "/chat",
    });
    return { sent: result.status === "sent" && result.accepted > 0, result };
  });

  // GET /api/notifications/push/delivery-stats — Push delivery observability
  app.get("/push/delivery-stats", async (request) => {
    const userId = getUserId(request);
    const { hours, limit } = request.query as { hours?: string; limit?: string };
    return getPushDeliveryStats(userId, {
      hours: parseOptionalInteger(hours),
      limit: parseOptionalInteger(limit),
    });
  });

  // DELETE /api/notifications/push/unsubscribe — Remove push subscription
  app.delete("/push/unsubscribe", async (request, reply) => {
    const userId = getUserId(request);
    const { endpoint } = request.body as { endpoint: string };
    if (!endpoint) {
      return reply.code(400).send({ error: "Endpoint required" });
    }

    await prisma.pushSubscription.deleteMany({ where: { endpoint, userId } });
    return reply.code(204).send();
  });

  // --- Native device push (Capacitor mobile shell, FCM/APNs) ---

  const FCM_TOKEN_MAX_LEN = 512;

  // POST /api/notifications/push/device-token/register — Register a native push
  // token. The shell calls this on launch after sign-in. Upsert by the unique
  // token so a re-registration (or a token claimed by a new account) moves the
  // row to the current user instead of duplicating it.
  app.post("/push/device-token/register", async (request, reply) => {
    const userId = getUserId(request);
    const { token, platform } = request.body as { token?: string; platform?: string };

    if (platform !== "android" && platform !== "ios") {
      return reply.code(400).send({ error: "platform must be 'android' or 'ios'" });
    }
    // Validate token shape per platform so garbage is rejected at registration,
    // not silently at send. FCM tokens are ~150-200 URL-safe chars; APNs tokens
    // are hex (64 today; Apple doesn't guarantee the length, so allow a range).
    const tokenOk =
      typeof token === "string" &&
      (platform === "ios"
        ? /^[0-9a-fA-F]{64,256}$/.test(token)
        : token.length <= FCM_TOKEN_MAX_LEN && /^[\w:.%-]+$/.test(token));
    if (!token || !tokenOk) {
      return reply.code(400).send({ error: "Invalid device push token" });
    }

    // A token is a stable device identifier. If it currently belongs to another
    // user (shared/MDM device, or a client sending a stale token), the upsert
    // below migrates it to the caller — log it so a hijack-shaped pattern is
    // visible rather than silent.
    const existing = await prisma.devicePushToken.findUnique({
      where: { token },
      select: { userId: true },
    });
    if (existing && existing.userId !== userId) {
      console.warn(
        `[PUSH-DEVICE] Device token reassigned from user ${existing.userId} to ${userId}`,
      );
    }

    await prisma.devicePushToken.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, platform },
    });
    console.log(`[PUSH-DEVICE] Registered ${platform} token for user ${userId}`);
    return reply.code(201).send({ success: true });
  });

  // DELETE /api/notifications/push/device-token — Unregister a token (sign-out).
  // Scoped to the caller so one user cannot drop another's.
  app.delete("/push/device-token", async (request, reply) => {
    const userId = getUserId(request);
    const { token } = request.body as { token?: string };
    if (!token) {
      return reply.code(400).send({ error: "Token required" });
    }
    await prisma.devicePushToken.deleteMany({ where: { token, userId } });
    return reply.code(204).send();
  });

  // POST /api/notifications/push/device-test — Ring the caller's device(s) via
  // FCM (Android). Proving path independent of the gated web-push pipeline.
  app.post("/push/device-test", async (request) => {
    const userId = getUserId(request);
    const result = await sendDevicePush(userId, {
      title: "Klorn test",
      body: "Native push is working.",
      url: "/chat",
    });
    return { sent: result.status === "sent" && result.accepted > 0, result };
  });
}

/**
 * Validate a Web Push endpoint URL (HTTPS, no private/internal hosts) to
 * prevent SSRF via attacker-supplied endpoints. Returns an error message or
 * null when valid. Shared by subscribe and rotate.
 */
function validatePushEndpointUrl(endpoint: string): string | null {
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    return "Invalid endpoint URL";
  }
  if (parsedEndpoint.protocol !== "https:") {
    return "Push endpoints must use HTTPS";
  }
  const host = parsedEndpoint.hostname.toLowerCase();
  const blockedHosts = ["localhost", "127.0.0.1", "::1", "metadata.google.internal"];
  if (blockedHosts.includes(host) || host.endsWith(".internal") || host.endsWith(".local")) {
    return "Invalid push endpoint host";
  }
  const ipMatch = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipMatch) {
    const [, a, b] = ipMatch.map(Number);
    if (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      a === 0
    ) {
      return "Invalid push endpoint host";
    }
  }
  return null;
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
