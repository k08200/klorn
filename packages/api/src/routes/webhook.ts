import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { prisma } from "../db.js";
import { sendPushNotification } from "../push.js";
import { captureError } from "../sentry.js";
import { PLANS, stripe } from "../stripe.js";
import { timingSafeEqualStr } from "../timing-safe-equal.js";
import { pushNotification } from "../websocket.js";

// RevenueCat event types that mean "the user has access". CANCELLATION (auto-
// renew off) is intentionally absent — the user keeps access until EXPIRATION.
const RC_GRANT_EVENTS = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "UNCANCELLATION",
  "NON_RENEWING_PURCHASE",
  "PRODUCT_CHANGE",
  "SUBSCRIPTION_EXTENDED",
]);
// Klorn user ids are uuids (@default(uuid())). RevenueCat anonymous ids
// ($RCAnonymousID:…) or anything malformed can't map to an account.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function webhookRoutes(app: FastifyInstance) {
  // POST /api/webhook/stripe — Stripe webhook handler
  app.post("/stripe", {
    config: { rawBody: true },
    handler: async (request, reply) => {
      const sig = request.headers["stripe-signature"] as string;
      const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

      if (!endpointSecret) {
        return reply.code(500).send({ error: "Webhook secret not configured" });
      }

      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(
          (request as unknown as { rawBody: string }).rawBody,
          sig,
          endpointSecret,
        );
      } catch {
        return reply.code(400).send({ error: "Invalid signature" });
      }

      // Dedup: skip already-processed events. Persisted in WebhookEvent (not an
      // in-memory map) so it survives restarts and is shared across dynos.
      // Recorded AFTER the switch so a transient DB failure (which throws → 500)
      // doesn't mark the event done and silently drop a revenue-bearing grant —
      // Stripe retries (up to 72h) and the retry re-applies it.
      const alreadyProcessed = await prisma.webhookEvent.findUnique({
        where: { id: event.id },
      });
      if (alreadyProcessed) {
        return { received: true };
      }

      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          const userId = session.metadata?.userId;
          const plan = session.metadata?.plan as "PRO" | "TEAM" | undefined;

          if (userId && plan) {
            await prisma.user.update({
              where: { id: userId },
              data: {
                plan,
                stripeId: session.customer as string,
              },
            });
          }
          break;
        }

        case "customer.subscription.updated": {
          const sub = event.data.object as Stripe.Subscription;
          const custId = sub.customer as string;
          const user = await prisma.user.findFirst({ where: { stripeId: custId } });
          if (!user) break;

          // Sync entitlement (user.plan) to the subscription's live status.
          // isEntitled() reads user.plan, so this is what actually grants/revokes
          // access. Previously past_due/unpaid only notified and left plan=PRO,
          // so a card decline at trial end kept the user entitled until Stripe
          // finally fired subscription.deleted days later.
          const entitled = sub.status === "active" || sub.status === "trialing";
          if (entitled) {
            // Re-grant/sync to the live plan. Map the price back to the plan
            // (legacy TEAM stays TEAM); default PRO. Unconditional + idempotent:
            // the previous `if (user.plan === "FREE")` guard skipped the write
            // for a non-FREE row, so an out-of-order past_due (which set FREE)
            // followed by active could leave a live subscriber wrongly downgraded.
            const priceId = sub.items?.data?.[0]?.price?.id;
            const plan = priceId && priceId === PLANS.TEAM.priceId ? "TEAM" : "PRO";
            await prisma.user.update({ where: { id: user.id }, data: { plan } });
          } else {
            // past_due / unpaid / canceled / incomplete_expired → revoke access.
            if (user.plan !== "FREE") {
              await prisma.user.update({ where: { id: user.id }, data: { plan: "FREE" } });
            }
            if (sub.status === "past_due" || sub.status === "unpaid") {
              const msg = `Your subscription is ${sub.status}. Please update your payment method to restore access.`;
              await notifyUser(user.id, "billing", "Payment Issue", msg, "/settings");
            }
          }
          break;
        }

        case "customer.subscription.deleted": {
          const subscription = event.data.object as Stripe.Subscription;
          const customerId = subscription.customer as string;

          const users = await prisma.user.findMany({ where: { stripeId: customerId } });
          await prisma.user.updateMany({
            where: { stripeId: customerId },
            data: { plan: "FREE" },
          });

          for (const user of users) {
            await notifyUser(
              user.id,
              "billing",
              "Subscription Cancelled",
              "Your subscription has been cancelled. You've been moved to the Free plan.",
              "/settings",
            );
          }
          break;
        }

        case "invoice.payment_failed": {
          const invoice = event.data.object as Stripe.Invoice;
          const failedCustomer = invoice.customer as string;

          const user = await prisma.user.findFirst({
            where: { stripeId: failedCustomer },
          });
          if (user) {
            await notifyUser(
              user.id,
              "billing",
              "Payment Failed",
              "Your latest payment failed. Please update your payment method to keep your plan active.",
              "/settings",
            );
          } else {
            // A payment failure for a customer we can't map to a user is a real
            // billing signal (stripeId drift) — never drop it silently.
            console.warn(`[STRIPE] payment_failed for unmapped customer ${failedCustomer}`);
            captureError(new Error("payment_failed for unmapped stripe customer"), {
              tags: { scope: "stripe.webhook" },
              extra: { customer: failedCustomer },
            });
          }
          break;
        }
      }

      // Mark processed only after the switch succeeded. create() (not upsert)
      // so a concurrent duplicate that raced past the findUnique above hits the
      // PK conflict and is swallowed — the work was idempotent either way.
      await prisma.webhookEvent.create({ data: { id: event.id } }).catch(() => {});
      return { received: true };
    },
  });

  // POST /api/webhook/revenuecat — RevenueCat (iOS/Android IAP) webhook.
  // Mirrors the Stripe handler: syncs the in-app subscription state to
  // user.plan, which isEntitled() reads. Auth is a shared secret in the
  // Authorization header (set identically in the RevenueCat dashboard) — RC
  // doesn't HMAC-sign, so no raw body is needed. app_user_id is the Klorn user
  // id (we configure RevenueCat with appUserID = user.id in iap.ts).
  app.post(
    "/revenuecat",
    { config: { rateLimit: { max: 100, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const expected = process.env.REVENUECAT_WEBHOOK_AUTH;
      if (!expected) return reply.code(500).send({ error: "Webhook auth not configured" });
      // Constant-time compare — the shared secret is the only gate on a route
      // that grants PRO, so a plain !== leaks the secret via a timing oracle.
      if (!timingSafeEqualStr((request.headers.authorization as string) ?? "", expected)) {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      const body = request.body as {
        event?: { id?: string; type?: string; app_user_id?: string };
      };
      const event = body?.event;
      if (!event?.id || !event?.type || !event?.app_user_id) {
        return reply.code(400).send({ error: "Malformed event" });
      }
      if (!UUID_RE.test(event.app_user_id)) {
        return reply.code(400).send({ error: "Invalid app_user_id" });
      }

      // Dedup (shared table with Stripe) — recorded after processing so a DB
      // blip doesn't drop a revenue-bearing grant (RevenueCat retries ~5 days).
      const alreadyProcessed = await prisma.webhookEvent.findUnique({ where: { id: event.id } });
      if (alreadyProcessed) return { received: true };

      const user = await prisma.user.findUnique({ where: { id: event.app_user_id } });
      if (user) {
        if (RC_GRANT_EVENTS.has(event.type)) {
          // Unconditional (like the Stripe handler) so an out-of-order event
          // can't leave a paying user stuck on FREE.
          await prisma.user.update({ where: { id: user.id }, data: { plan: "PRO" } });
        } else if (event.type === "EXPIRATION") {
          if (user.plan !== "FREE") {
            await prisma.user.update({ where: { id: user.id }, data: { plan: "FREE" } });
          }
        } else if (event.type === "BILLING_ISSUE") {
          // Grace period: notify, don't revoke. EXPIRATION revokes if it lapses.
          await notifyUser(
            user.id,
            "billing",
            "Payment Issue",
            "Your subscription payment failed. Please update your payment method to keep your plan.",
            "/settings",
          );
        }
      }

      await prisma.webhookEvent.create({ data: { id: event.id } }).catch((err) => {
        // A PK conflict from a raced duplicate is expected; surface anything else.
        if ((err as { code?: string })?.code !== "P2002") {
          captureError(err, {
            tags: { scope: "revenuecat.webhook.dedup" },
            extra: { id: event.id },
          });
        }
      });
      return { received: true };
    },
  );
}

/** Create DB notification + WebSocket push + browser push */
async function notifyUser(
  userId: string,
  type: string,
  title: string,
  message: string,
  url: string,
) {
  const notification = await prisma.notification.create({
    data: { userId, type, title, message, link: url },
  });

  pushNotification(userId, {
    id: notification.id,
    type,
    title,
    message,
    link: url,
    createdAt: notification.createdAt.toISOString(),
  });

  // Guard the fire-and-forget push: an unhandled rejection from the async DB
  // work inside sendPushNotification can crash the dyno (no unhandledRejection
  // handler) — same guard every other call site uses.
  sendPushNotification(userId, { title, body: message, url }).catch((err) => {
    console.warn("[WEBHOOK] push failed", err);
    captureError(err, { tags: { scope: "webhook.push", userId } });
  });
}
