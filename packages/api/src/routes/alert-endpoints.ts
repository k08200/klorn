/**
 * Settings → Notifications → "Where you get alerts" (N8).
 *
 *   GET    /api/notifications/alert-endpoints             the caller's endpoints
 *   POST   /api/notifications/alert-endpoints/web/:id/test
 *   POST   /api/notifications/alert-endpoints/native/:id/test
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
 * by web and native rows, on top of the app-wide per-IP limit.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { prisma } from "../db.js";
import { alertTestCopy, buildAlertEndpoints } from "../notify/alert-endpoints.js";
import { desktopPresence } from "../notify/desktop-presence.js";
import { getUserNotificationLanguage } from "../notify/notification-strings.js";
import { sendTestPushToSubscription } from "../notify/push.js";
import { sendApnsPush } from "../notify/push-apns.js";
import { sendDevicePush } from "../notify/push-device.js";
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
    const deviceId = request.headers[DEVICE_ID_HEADER];
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
        },
        orderBy: { createdAt: "asc" },
      }),
      prisma.devicePushToken.findMany({
        where: { userId },
        select: { id: true, platform: true, updatedAt: true },
        orderBy: { updatedAt: "asc" },
      }),
    ]);
    const receipts =
      web.length === 0
        ? []
        : await prisma.pushDeliveryLog.groupBy({
            by: ["subscriptionId"],
            where: {
              userId,
              subscriptionId: { in: web.map((row) => row.id) },
              receivedAt: { not: null },
            },
            _max: { receivedAt: true },
          });
    const lastReceivedBySubscription = new Map<string, Date>();
    for (const r of receipts) {
      if (r.subscriptionId && r._max.receivedAt) {
        lastReceivedBySubscription.set(r.subscriptionId, r._max.receivedAt);
      }
    }
    const now = Date.now();
    return buildAlertEndpoints({
      web,
      native,
      desktop: desktopPresence.list(userId, now),
      lastReceivedBySubscription,
      currentDeviceId: typeof deviceId === "string" && deviceId ? deviceId : undefined,
      now,
    });
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
      return { sent: result.delivered };
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
      const send = row.platform === "ios" ? sendApnsPush : sendDevicePush;
      const result = await send(userId, copy, "system", { tokenId: row.id });
      if (result.status !== "sent") return { sent: false, reason: result.reason };
      return { sent: result.accepted > 0 };
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
