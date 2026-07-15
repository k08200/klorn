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
import { MULTI_INBOX_SYNC_ENABLED } from "../config.js";
import { prisma } from "../db.js";
import { verifyGoogleOidcToken } from "../google-oidc.js";
import { syncEmails } from "../mail/email-sync.js";
import { getAuthedInboxClient, registerGmailWatch, stopGmailWatch } from "../mail/gmail.js";
import { captureError } from "../sentry.js";
import { timingSafeEqualStr } from "../timing-safe-equal.js";
import { pushNotification } from "../websocket.js";

function extractBearerToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice(7).trim();
  }
  return null;
}

async function authorizePushRequest(
  req: FastifyRequest,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const oidcEmail = process.env.GMAIL_PUSH_OIDC_EMAIL;
  const shared = process.env.GMAIL_PUSH_TOKEN;
  const token = extractBearerToken(req);

  if (oidcEmail) {
    // Fail closed: without an audience, google-auth-library skips audience
    // binding entirely (audience: undefined), so ANY Google-signed token whose
    // email matches would be accepted. Require the audience to be configured
    // whenever OIDC auth is enabled, so verifyGoogleOidcToken always binds it.
    if (!process.env.GMAIL_PUSH_OIDC_AUDIENCE) {
      return { ok: false, reason: "OIDC audience not configured" };
    }
    if (!token) return { ok: false, reason: "missing OIDC token" };
    // Signature, expiry, and issuer are verified against Google's certs —
    // claims from an unverified decode are attacker-controlled and must
    // never be trusted on their own.
    const claims = await verifyGoogleOidcToken(token);
    if (!claims) return { ok: false, reason: "OIDC token failed verification" };
    if (claims.email_verified !== true) {
      return { ok: false, reason: "OIDC email not verified" };
    }
    if (claims.email?.toLowerCase() !== oidcEmail.toLowerCase()) {
      return { ok: false, reason: "OIDC email mismatch" };
    }
    return { ok: true };
  }

  if (shared) {
    if (token && timingSafeEqualStr(token, shared)) return { ok: true };
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
  // No requireAuth here — Pub/Sub posts as Google, not as the user. The auth
  // boundary is a signature-verified Google OIDC token (or the GMAIL_PUSH_TOKEN
  // shared secret via Authorization header).
  app.post("/push", async (request, reply) => {
    if (!process.env.GMAIL_PUSH_TOKEN && !process.env.GMAIL_PUSH_OIDC_EMAIL) {
      return reply.code(503).send({ error: "Gmail push not configured" });
    }
    const result = await authorizePushRequest(request);
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

    // payload is JSON.parse output (effectively untyped): a non-string
    // emailAddress (e.g. a number) would throw on .toLowerCase() and 500 the
    // public webhook. Guard the type, then ack-drain anything malformed.
    const rawEmail = payload.emailAddress;
    const email = typeof rawEmail === "string" ? rawEmail.toLowerCase() : "";
    if (!email) {
      return reply.code(204).send();
    }

    // Fire-and-forget the sync so we return fast and Pub/Sub does not time out.
    // The 1-minute polling fallback will catch up, so this is non-fatal — but a
    // consistently failing sync (DB down, quota, expired auth) must still reach
    // error tracking, not just dyno logs. console.warn keeps a signal when
    // Sentry is not configured; captureError preserves the stack + context.
    // On new mail, tell every open client to refetch (conversations-updated is
    // the app-wide refresh signal that NotificationBell bridges to a window
    // event) instead of making the user press "Sync".
    const runSyncAndNotify = (uid: string, syncPromise: Promise<{ newCount: number }>) => {
      syncPromise
        .then((result) => {
          if (result.newCount > 0) {
            pushNotification(uid, {
              id: "mail-sync",
              type: "system",
              title: "conversations-updated",
              message: "",
              createdAt: new Date().toISOString(),
            });
          }
        })
        .catch((err) => {
          console.warn(`[GMAIL-PUSH] sync failed for ${uid}: ${String(err)}`);
          captureError(err, { tags: { scope: "gmail-push.sync" }, extra: { userId: uid } });
        });
    };

    // `email` is already lowercased (above), and every write path stores
    // User.email / LinkedInboxAccount.email via normalizeEmail (lowercased), so
    // an EXACT match is equivalent to the old case-insensitive one for all stored
    // rows — but it can use the indexes (User.email @unique, LinkedInboxAccount's
    // email index) instead of seq-scanning on every push (the hottest path).
    const user = await prisma.user.findFirst({
      where: { email },
      select: { id: true },
    });
    if (user) {
      runSyncAndNotify(user.id, syncEmails(user.id, 30));
      return reply.code(204).send();
    }

    // Multi-account: the pubsub address may be a LINKED secondary inbox, whose
    // email is NOT a User.email. Route it to the owning user + account and sync
    // through that inbox's own client. Gated so nothing routes while the feature
    // is off. We NEVER resolve the session user by this address — only the
    // pre-linked LinkedInboxAccount row's userId.
    if (MULTI_INBOX_SYNC_ENABLED) {
      const linked = await prisma.linkedInboxAccount.findFirst({
        where: { email },
        select: { id: true, userId: true },
      });
      if (linked) {
        const client = await getAuthedInboxClient(linked.userId, linked.id);
        if (client) {
          runSyncAndNotify(
            linked.userId,
            syncEmails(linked.userId, 30, undefined, { id: linked.id, email, client }),
          );
        } else {
          // Known linked inbox but its token is unusable (revoked/undecryptable):
          // getAuthedInboxClient already flags it needsReconnect, but the push
          // sync is silently skipped here — surface it so a stalled real-time
          // inbox is observable, not just drained to 204.
          console.warn(
            `[GMAIL-PUSH] Skipped real-time sync for linked inbox ${linked.id} — client unavailable (needs reconnect)`,
          );
          captureError(new Error("Linked inbox client unavailable on push"), {
            tags: { scope: "gmail-push.linked-inbox" },
            extra: { linkedInboxAccountId: linked.id, userId: linked.userId },
          });
        }
        return reply.code(204).send();
      }
    }

    // Unknown address — ack to drain the subscription.
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
