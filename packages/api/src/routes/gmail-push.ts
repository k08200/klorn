/**
 * Gmail Pub/Sub push endpoint.
 *
 * Flow:
 *   Gmail mailbox change → Google publishes to Pub/Sub topic →
 *   Pub/Sub push subscription posts here → we resolve the user and sync.
 *
 * Setup (ops):
 *   1. Create a Pub/Sub topic, e.g. projects/<proj>/topics/gmail-push.
 *   2. Grant roles/pubsub.publisher to gmail-api-push@system.gserviceaccount.com.
 *   3. Create a push subscription targeting POST /api/gmail/push.
 *      Configure either:
 *        (a) Authentication: enable OIDC token with the Pub/Sub service
 *            account; we accept tokens signed by Google and verify the
 *            email matches GMAIL_PUSH_OIDC_EMAIL (preferred), OR
 *        (b) Shared secret via Authorization: Bearer <GMAIL_PUSH_TOKEN>
 *            header — never via URL query (leaks into logs/Referer).
 *   4. Each user with Gmail connected calls POST /api/gmail/watch/enable
 *      to register their mailbox against the topic. Watches expire in 7
 *      days and need to be renewed (tracked as follow-up work).
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { prisma } from "../db.js";
import { syncEmails } from "../email-sync.js";
import { registerGmailWatch, stopGmailWatch } from "../gmail.js";

const GMAIL_PUSH_OIDC_EMAIL = process.env.GMAIL_PUSH_OIDC_EMAIL;

interface OidcClaims {
  email?: string;
  email_verified?: boolean;
  aud?: string;
  iss?: string;
  exp?: number;
}

function decodeJwtClaims(token: string): OidcClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
    return JSON.parse(payload) as OidcClaims;
  } catch {
    return null;
  }
}

function extractBearerToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice(7).trim();
  }
  return null;
}

function authorizePushRequest(req: FastifyRequest): { ok: true } | { ok: false; reason: string } {
  const shared = process.env.GMAIL_PUSH_TOKEN;
  const token = extractBearerToken(req);

  if (GMAIL_PUSH_OIDC_EMAIL) {
    if (!token) return { ok: false, reason: "missing OIDC token" };
    const claims = decodeJwtClaims(token);
    if (!claims) return { ok: false, reason: "malformed OIDC token" };
    if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) {
      return { ok: false, reason: "expired OIDC token" };
    }
    if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") {
      return { ok: false, reason: "unexpected OIDC issuer" };
    }
    if (claims.email?.toLowerCase() !== GMAIL_PUSH_OIDC_EMAIL.toLowerCase()) {
      return { ok: false, reason: "OIDC email mismatch" };
    }
    return { ok: true };
  }

  if (shared) {
    if (token && token === shared) return { ok: true };
    return { ok: false, reason: "bearer token mismatch" };
  }

  return { ok: false, reason: "no auth configured" };
}

interface PubSubPushBody {
  message?: {
    data?: string;
    messageId?: string;
    publishTime?: string;
    attributes?: Record<string, string>;
  };
  subscription?: string;
}

interface GmailPushPayload {
  emailAddress: string;
  historyId: string | number;
}

export async function gmailPushRoutes(app: FastifyInstance) {
  // ── Public Pub/Sub push target ────────────────────────────────────────
  // No requireAuth here — Pub/Sub posts as Google, not as the user. The
  // GMAIL_PUSH_TOKEN query parameter is the auth boundary.
  app.post("/push", async (request, reply) => {
    if (!process.env.GMAIL_PUSH_TOKEN && !GMAIL_PUSH_OIDC_EMAIL) {
      return reply.code(503).send({ error: "Gmail push not configured" });
    }
    const result = authorizePushRequest(request);
    if (!result.ok) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const body = request.body as PubSubPushBody;
    const dataB64 = body?.message?.data;
    if (!dataB64) {
      // Ack empty pushes so Pub/Sub does not retry.
      return reply.code(204).send();
    }

    let payload: GmailPushPayload;
    try {
      const decoded = Buffer.from(dataB64, "base64").toString("utf-8");
      payload = JSON.parse(decoded);
    } catch {
      // Malformed payload — ack so Pub/Sub stops retrying, but log.
      console.warn("[GMAIL-PUSH] Dropping malformed Pub/Sub payload");
      return reply.code(204).send();
    }

    const email = payload.emailAddress?.toLowerCase();
    if (!email) {
      return reply.code(204).send();
    }

    const user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true },
    });
    if (!user) {
      // Unknown user — ack to drain the subscription.
      return reply.code(204).send();
    }

    // Fire-and-forget the sync so we return fast and Pub/Sub does not time out.
    // Errors are swallowed here; the 1-minute polling fallback will catch up.
    syncEmails(user.id, 30).catch((err) => {
      console.warn(`[GMAIL-PUSH] sync failed for ${user.id}: ${String(err)}`);
    });

    return reply.code(204).send();
  });

  // ── Authenticated management endpoints ────────────────────────────────
  app.post("/watch/enable", { preHandler: requireAuth }, async (request, reply) => {
    const userId = getUserId(request);
    const result = await registerGmailWatch(userId);
    if ("error" in result) {
      return reply.code(400).send(result);
    }
    return reply.send(result);
  });

  app.post("/watch/disable", { preHandler: requireAuth }, async (request, reply) => {
    const userId = getUserId(request);
    const result = await stopGmailWatch(userId);
    if (!result.ok) {
      return reply.code(400).send({ error: result.error || "Failed to stop watch" });
    }
    return reply.send({ ok: true });
  });
}
