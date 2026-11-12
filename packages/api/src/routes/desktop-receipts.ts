/**
 * Desktop notification receipts — the Mac and Windows apps report what became
 * of a banner they posted, so "did it reach the person, and did they act?"
 * has an answer for desktop too (notify/delivery-lifecycle.ts).
 *
 *   POST /api/notifications/desktop/receipts
 *   Authorization: Bearer <the app's session token>   (the same as every call)
 *   Content-Type: application/json
 *   {
 *     "app":    "mac" | "windows",
 *     "event":  "shown" | "clicked" | "actioned",
 *     "kind":   "notification" | "attention_item" | "calendar_event",
 *     "id":     "<uuid>",               // the id the app keyed the banner on
 *     "action": "reply" | "later"       // required with "actioned", else absent
 *   }
 *
 *   204  recorded — also for a repeat: reports are idempotent
 *   400  body does not match the schema above
 *   401  no or expired session
 *   404  no such id among the caller's own notifications / items / events
 *   429  over DESKTOP_RECEIPT_RATE_LIMIT for this user (retry-after header)
 *
 * Event → lifecycle stage, each stamped by its first report only:
 *   shown    → device_received   (Mac: the UNUserNotificationCenter.add
 *                                 completion with no error; Windows: the
 *                                 Tauri banner was displayed)
 *   clicked  → opened            (Mac: userNotificationCenter(_:didReceive:)
 *                                 with the default action; Windows: banner
 *                                 click). Also stamps device_received.
 *   actioned → actioned + action (an action button). Also stamps opened.
 *
 * kind: "attention_item" for a mail banner keyed on the firewall item id (the
 * Mac's `klorn-push-<id>`), "calendar_event" for a meeting-soon banner
 * (`klorn-meeting-<id>`), "notification" for a bell row id (the Windows shell,
 * which toasts bell rows). Clients should report fire-and-forget and may drop
 * a report on failure; a 4xx must not be retried.
 *
 * Timestamps are the server's receive time. The user always comes from the
 * session — a body field naming one is ignored.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import {
  DESKTOP_RECEIPT_EVENTS,
  DESKTOP_RECEIPT_KINDS,
  type DesktopReceiptEvent,
  type DesktopReceiptKind,
  recordDesktopReceipt,
} from "../notify/channel-delivery-log.js";
import { RECEIPT_ACTIONS, type ReceiptAction } from "../notify/delivery-lifecycle.js";
import { rateLimitHook } from "./rate-limit-hook.js";

/** A sync can post a handful of banners at once, each reported once or twice. */
export const DESKTOP_RECEIPT_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const;

const bodySchema = {
  type: "object",
  required: ["app", "event", "kind", "id"],
  additionalProperties: false,
  properties: {
    app: { type: "string", enum: ["mac", "windows"] },
    event: { type: "string", enum: [...DESKTOP_RECEIPT_EVENTS] },
    kind: { type: "string", enum: [...DESKTOP_RECEIPT_KINDS] },
    id: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" },
    action: { type: "string", enum: [...RECEIPT_ACTIONS] },
  },
} as const;

interface DesktopReceiptBody {
  app: "mac" | "windows";
  event: DesktopReceiptEvent;
  kind: DesktopReceiptKind;
  id: string;
  action?: ReceiptAction;
}

export async function desktopReceiptRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  const limit = rateLimitHook(
    app,
    DESKTOP_RECEIPT_RATE_LIMIT,
    (request: FastifyRequest) => `desktop-receipt:user:${getUserId(request)}`,
    "Too many notification receipts. Try again in a minute.",
  );

  app.post("/", { schema: { body: bodySchema }, preHandler: limit }, async (request, reply) => {
    const userId = getUserId(request);
    const body = request.body as DesktopReceiptBody;
    // An action belongs to "actioned" and only there.
    if ((body.event === "actioned") !== (body.action !== undefined)) {
      return reply.code(400).send({ error: "action is required with actioned, and only there" });
    }
    const result = await recordDesktopReceipt({
      userId,
      app: body.app,
      event: body.event,
      kind: body.kind,
      id: body.id,
      ...(body.action ? { action: body.action } : {}),
    });
    if (result === "not_found") {
      return reply.code(404).send({ error: "Notification not found" });
    }
    return reply.code(204).send();
  });
}
