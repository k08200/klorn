/**
 * Settings → Notifications → "Where you get alerts" (N8).
 *
 *   GET    /api/notifications/alert-endpoints             the caller's endpoints
 *   GET    /api/notifications/alert-endpoints/health      can any channel reach them?
 *   GET    /api/notifications/alert-endpoints/deliveries/:id   a test's lifecycle
 *   POST   /api/notifications/alert-endpoints/web/:id/test     → { sent, deliveryId? }
 *   POST   /api/notifications/alert-endpoints/native/:id/test  → { sent, deliveryId? }
 *   DELETE /api/notifications/alert-endpoints/web/:id
 *   DELETE /api/notifications/alert-endpoints/native/:id
 *
 * Every route requires a session and scopes each query by the caller's user
 * id, so an id belonging to someone else is indistinguishable from a missing
 * one (404). Auth is the bearer token in the Authorization header, so these are
 * not CSRF-reachable from another origin. The list carries ids and labels only
 * (notify/alert-endpoints.ts) — never an endpoint URL, key or device token.
 *
 * Test sends skip quiet hours and category preferences on purpose (see
 * sendTestPushToSubscription) and are capped by a per-user rate limit shared
 * by web and native rows, on top of the app-wide per-IP limit. Each records a
 * delivery row; its id comes back so the client can poll deliveries/:id and
 * show whether the test reached the device (web push: the service worker's
 * receipt) or only the provider (FCM / APNs report no receipt).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { prisma } from "../db.js";
import { alertTestCopy, buildAlertEndpoints } from "../notify/alert-endpoints.js";
import {
  getDeliveryStatus,
  nativeSendOutcome,
  recordChannelSend,
} from "../notify/channel-delivery-log.js";
import { buildChannelHealth, mergeDesktopSightings } from "../notify/channel-health.js";
import { DESKTOP_CHANNELS } from "../notify/delivery-lifecycle.js";
import { desktopPresence } from "../notify/desktop-presence.js";
import { getUserNotificationLanguage } from "../notify/notification-strings.js";
import { sendTestPushToSubscription } from "../notify/push.js";
import { sendApnsPush } from "../notify/push-apns.js";
import { sendDevicePush } from "../notify/push-device.js";
import { isTelegramConfigured } from "../notify/telegram.js";
import { rateLimitHook } from "./rate-limit-hook.js";

/** Five test pushes per ten minutes per user, across all of their rows. */
export const ALERT_TEST_RATE_LIMIT = { max: 5, timeWindow: "10 minutes" } as const;

const TEST_URL = "/settings";
const DEVICE_ID_MAX_LEN = 128;

/** The browser's push device id (lib/push.ts getPushDeviceId), so the list can
 *  mark "This browser". A header, not a query param, to keep the stable
 *  per-browser id out of URL access logs. */
const DEVICE_ID_HEADER = "x-push-device";

const listHeadersSchema = {
  type: "object",
  properties: { [DEVICE_ID_HEADER]: { type: "string", maxLength: DEVICE_ID_MAX_LEN } },
} as const;

// Row ids are Prisma uuids. Reject anything else before a query runs.
const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" } },
} as const;

async function testCopyFor(userId: string) {
  return alertTestCopy(await getUserNotificationLanguage(userId), TEST_URL);
}

function currentDeviceId(request: FastifyRequest): string | undefined {
  const deviceId = request.headers[DEVICE_ID_HEADER];
  return typeof deviceId === "string" && deviceId ? deviceId : undefined;
}

/** Latest service-worker receipt per subscription (scoped to the caller). */
async function lastReceivedBySubscription(
  userId: string,
  subscriptionIds: string[],
): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (subscriptionIds.length === 0) return out;
  const receipts = await prisma.pushDeliveryLog.groupBy({
    by: ["subscriptionId"],
    where: { userId, subscriptionId: { in: subscriptionIds }, receivedAt: { not: null } },
    _max: { receivedAt: true },
  });
  for (const r of receipts) {
    if (r.subscriptionId && r._max.receivedAt) out.set(r.subscriptionId, r._max.receivedAt);
  }
  return out;
}

export async function alertEndpointRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  const testLimit = rateLimitHook(
    app,
    ALERT_TEST_RATE_LIMIT,
    (request: FastifyRequest) => `alert-test:user:${getUserId(request)}`,
    "Too many test alerts. Try again in a few minutes.",
  );

  app.get("/", { schema: { headers: listHeadersSchema } }, async (request) => {
    const userId = getUserId(request);
    const [web, native] = await Promise.all([
      prisma.pushSubscription.findMany({
        where: { userId },
        select: {
          id: true,
          endpoint: true,
          deviceId: true,
          browser: true,
          os: true,
          createdAt: true,
          needsResubscribeAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      prisma.devicePushToken.findMany({
        where: { userId },
        select: { id: true, platform: true, updatedAt: true },
        orderBy: { updatedAt: "asc" },
      }),
    ]);
    const now = Date.now();
    return buildAlertEndpoints({
      web,
      native,
      desktop: desktopPresence.list(userId, now),
      lastReceivedBySubscription: await lastReceivedBySubscription(
        userId,
        web.map((row) => row.id),
      ),
      currentDeviceId: currentDeviceId(request),
      now,
    });
  });

  // Can any off-app channel reach the caller? Drives the "no working channel"
  // banner and this browser's "turn alerts back on" (notify/channel-health.ts).
  app.get("/health", { schema: { headers: listHeadersSchema } }, async (request) => {
    const userId = getUserId(request);
    const [web, native, user, desktopReceipts] = await Promise.all([
      prisma.pushSubscription.findMany({
        where: { userId },
        select: { id: true, deviceId: true, createdAt: true, needsResubscribeAt: true },
      }),
      prisma.devicePushToken.findMany({ where: { userId }, select: { id: true } }),
      prisma.user.findUnique({ where: { id: userId }, select: { telegramChatId: true } }),
      prisma.pushDeliveryLog.groupBy({
        by: ["channel"],
        where: { userId, channel: { in: [...DESKTOP_CHANNELS] } },
        _max: { updatedAt: true },
      }),
    ]);
    const received = await lastReceivedBySubscription(
      userId,
      web.map((row) => row.id),
    );
    const now = Date.now();
    return buildChannelHealth({
      web: web.map((row) => ({ row, lastReceivedAt: received.get(row.id) ?? null })),
      nativeTokens: native.length,
      telegramLinked: Boolean(user?.telegramChatId) && isTelegramConfigured(),
      desktop: mergeDesktopSightings(
        desktopPresence.list(userId, now),
        desktopReceipts.map((r) => ({ channel: r.channel, lastAt: r._max.updatedAt })),
      ),
      currentDeviceId: currentDeviceId(request),
      now,
    });
  });

  // One of the caller's own delivery rows as its lifecycle stage — the
  // "Send test" row polls this to show the test arriving.
  app.get("/deliveries/:id", { schema: { params: idParamsSchema } }, async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };
    const status = await getDeliveryStatus(userId, id);
    if (!status) return reply.code(404).send({ error: "Delivery not found" });
    return status;
  });

  app.post(
    "/web/:id/test",
    { schema: { params: idParamsSchema }, preHandler: testLimit },
    async (request, reply) => {
      const userId = getUserId(request);
      const { id } = request.params as { id: string };
      const result = await sendTestPushToSubscription(userId, id, await testCopyFor(userId));
      if (result.status === "not_found") return notFound(reply);
      if (result.status === "skipped") return { sent: false, reason: result.reason };
      return { sent: result.delivered, deliveryId: result.deliveryId };
    },
  );

  app.post(
    "/native/:id/test",
    { schema: { params: idParamsSchema }, preHandler: testLimit },
    async (request, reply) => {
      const userId = getUserId(request);
      const { id } = request.params as { id: string };
      const row = await prisma.devicePushToken.findFirst({
        where: { id, userId },
        select: { id: true, platform: true },
      });
      if (!row) return notFound(reply);
      const copy = await testCopyFor(userId);
      const ios = row.platform === "ios";
      const send = ios ? sendApnsPush : sendDevicePush;
      const queuedAt = new Date();
      const result = await send(userId, copy, "system", { tokenId: row.id });
      const outcome = nativeSendOutcome(result);
      const deliveryId = outcome
        ? await recordChannelSend({
            userId,
            channel: ios ? "apns" : "fcm",
            category: "system",
            title: copy.title,
            outcome,
            queuedAt,
          })
        : null;
      const tracked = deliveryId ? { deliveryId } : {};
      if (result.status !== "sent") return { sent: false, reason: result.reason, ...tracked };
      return { sent: result.accepted > 0, ...tracked };
    },
  );

  app.delete("/web/:id", { schema: { params: idParamsSchema } }, async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };
    const { count } = await prisma.pushSubscription.deleteMany({ where: { id, userId } });
    return count === 0 ? notFound(reply) : reply.code(204).send();
  });

  app.delete("/native/:id", { schema: { params: idParamsSchema } }, async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params as { id: string };
    const { count } = await prisma.devicePushToken.deleteMany({ where: { id, userId } });
    return count === 0 ? notFound(reply) : reply.code(204).send();
  });
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ error: "Alert endpoint not found" });
}
