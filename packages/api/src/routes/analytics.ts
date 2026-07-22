import type { FastifyInstance } from "fastify";
import { ANALYTICS_EVENTS, isAnalyticsEvent, recordEvent } from "../analytics.js";
import { getUserId, requireAuth } from "../auth.js";

// Cap the client-supplied meta so a client can't dump large / arbitrary blobs
// into the analytics table (boundary validation per the engineering doctrine).
const MAX_META_BYTES = 400;

function sanitizeMeta(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const entries = Object.entries(input as Record<string, unknown>).slice(0, 8);
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    // Only primitives — no nested objects, no message content.
    if (typeof v === "string") out[k] = v.slice(0, 64);
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  if (JSON.stringify(out).length > MAX_META_BYTES) return undefined;
  return Object.keys(out).length ? out : undefined;
}

export async function analyticsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // POST /api/analytics/event — first-party product-analytics ingest.
  // Body: { event: <allowlisted name>, meta?: { small primitives } }.
  // Fire-and-forget: always 202, never blocks or errors the client's UX.
  app.post("/event", async (request, reply) => {
    const userId = getUserId(request);
    const body = (request.body ?? {}) as { event?: unknown; meta?: unknown };

    if (!isAnalyticsEvent(body.event)) {
      return reply.code(400).send({ error: "unknown event", allowed: ANALYTICS_EVENTS });
    }
    // push_sent is a server-only signal (open-rate denominator); never accept
    // it from a client, which could inflate the rate.
    if (body.event === "push_sent") {
      return reply.code(400).send({ error: "server-only event" });
    }

    void recordEvent(userId, body.event, sanitizeMeta(body.meta));
    return reply.code(202).send({ ok: true });
  });
}
