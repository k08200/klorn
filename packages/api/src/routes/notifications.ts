import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import {
  clearNotifications,
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "../background.js";
import { prisma } from "../db.js";
import { getVapidPublicKey, sendPushNotification } from "../push.js";
import { getPushDeliveryStats, recordPushReceipt } from "../push-delivery.js";
import { isAllowedPushOrigin } from "../push-origin-allowlist.js";

export async function notificationRoutes(app: FastifyInstance) {
  // POST /api/notifications/push/receipts/:deliveryId — public, high-entropy
  // receipt from the service worker. It returns no user data.
  app.post("/push/receipts/:deliveryId", async (request, reply) => {
    const { deliveryId } = request.params as { deliveryId: string };
    const { event } = (request.body || {}) as { event?: "received" | "clicked" };
    if (event !== "received" && event !== "clicked") {
      return reply.code(400).send({ error: "Invalid receipt event" });
    }
    await recordPushReceipt(deliveryId, event);
    return reply.code(204).send();
  });

  app.addHook("preHandler", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    if (
      path.startsWith("/push/receipts/") ||
      path.startsWith("/api/notifications/push/receipts/")
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

    // Validate push endpoint URL to prevent SSRF
    let parsedEndpoint: URL;
    try {
      parsedEndpoint = new URL(endpoint);
    } catch {
      return reply.code(400).send({ error: "Invalid endpoint URL" });
    }
    if (parsedEndpoint.protocol !== "https:") {
      return reply.code(400).send({ error: "Push endpoints must use HTTPS" });
    }
    const host = parsedEndpoint.hostname.toLowerCase();
    // Block private/internal addresses
    const blockedHosts = ["localhost", "127.0.0.1", "::1", "metadata.google.internal"];
    if (blockedHosts.includes(host) || host.endsWith(".internal") || host.endsWith(".local")) {
      return reply.code(400).send({ error: "Invalid push endpoint host" });
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
        return reply.code(400).send({ error: "Invalid push endpoint host" });
      }
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
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
