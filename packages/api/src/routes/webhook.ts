import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { verifyPaddleSignature } from "../billing/paddle.js";
import { PLANS, stripe } from "../billing/stripe.js";
import { prisma } from "../db.js";
import { sendPushNotification } from "../notify/push.js";
import { captureError } from "../sentry.js";
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
              await notifyUser(
                user.id,
                "billing",
                "Payment Issue",
                msg,
                "/settings/account-billing",
              );
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
              "/settings/account-billing",
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
              "/settings/account-billing",
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

  // POST /api/webhook/paddle — Paddle Billing (web MoR) webhook. Mirrors the
  // Stripe handler's semantics: sync the subscription's live status to
  // user.plan (active/trialing → PRO; past_due/paused/canceled → FREE with a
  // notification), dedup via WebhookEvent, record processed only after the
  // work succeeded so Paddle's retries re-apply a grant lost to a DB blip.
  // The user is mapped via custom_data.userId (set at checkout creation in
  // paddle.ts); the stored paddleCustomerId is the fallback for events that
  // arrive without custom_data.
  app.post("/paddle", {
    config: { rawBody: true },
    handler: async (request, reply) => {
      const secret = process.env.PADDLE_WEBHOOK_SECRET;
      if (!secret) {
        return reply.code(500).send({ error: "Webhook secret not configured" });
      }
      const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? "";
      const signature = request.headers["paddle-signature"] as string | undefined;
      if (!verifyPaddleSignature(rawBody, signature, secret)) {
        return reply.code(401).send({ error: "Invalid signature" });
      }

      const body = request.body as {
        event_id?: string;
        event_type?: string;
        occurred_at?: string;
        data?: {
          id?: string;
          status?: string;
          customer_id?: string;
          custom_data?: { userId?: string } | null;
          next_billed_at?: string | null;
          scheduled_change?: { action?: string; effective_at?: string | null } | null;
        };
      };
      if (!body?.event_id || !body?.event_type || !body?.data) {
        return reply.code(400).send({ error: "Malformed event" });
      }

      const alreadyProcessed = await prisma.webhookEvent.findUnique({
        where: { id: body.event_id },
      });
      if (alreadyProcessed) return { received: true };

      if (body.event_type.startsWith("subscription.")) {
        const data = body.data;
        // Primary mapping: the userId we attached at checkout. Fallback: the
        // customer id stored on a previous event for this user.
        const customUserId = data.custom_data?.userId;
        const user =
          customUserId && UUID_RE.test(customUserId)
            ? await prisma.user.findUnique({ where: { id: customUserId } })
            : null;
        const mapped =
          user ??
          (data.customer_id
            ? await prisma.user.findFirst({ where: { paddleCustomerId: data.customer_id } })
            : null);

        if (!mapped) {
          // A subscription event we can't map is a real billing signal (lost
          // custom_data or customer drift) — never drop it silently.
          console.warn(`[PADDLE] unmapped subscription event ${body.event_id}`);
          captureError(new Error("paddle subscription event for unmapped user"), {
            tags: { scope: "paddle.webhook" },
            extra: { eventId: body.event_id, customer: data.customer_id },
          });
        } else {
          // paddleCustomerId and paddleSubscriptionId are both @unique. If
          // either id is currently recorded on a DIFFERENT account (a
          // subscription moved between accounts, or a mapping drift through
          // the customer-id fallback above), the update below throws P2002 —
          // and because the event is only marked processed AFTER the work,
          // Paddle would retry that same failing event forever while this
          // subscriber's state never syncs. Detach the ids from the other row
          // first and surface it, rather than deadlocking the webhook.
          await detachPaddleIdsFromOtherUsers(mapped.id, data.id, data.customer_id);

          // Ordering guard. Dedup by event_id stops a REPLAY, not an
          // out-of-order pair: a retried "cancel scheduled" landing after the
          // newer "cancel removed" would otherwise resurrect the cancellation
          // in the UI. Entitlement (plan) stays unconditional either way —
          // it is order-insensitive; only the display detail is skipped.
          const eventAt = body.occurred_at ? new Date(body.occurred_at) : null;
          const priorEventAt = mapped.subscriptionEventAt;
          const stale = Boolean(
            eventAt && !Number.isNaN(eventAt.getTime()) && priorEventAt && eventAt < priorEventAt,
          );
          const detail = (fields: Record<string, unknown>) =>
            stale ? {} : { ...fields, subscriptionEventAt: eventAt ?? undefined };

          const entitled = data.status === "active" || data.status === "trialing";
          if (entitled) {
            // Unconditional + idempotent (like Stripe/RevenueCat) so an
            // out-of-order past_due followed by active can't leave a live
            // subscriber downgraded. Store the customer id for the portal
            // route and for custom_data-less future events, plus the live
            // subscription detail the /billing page renders: the sub id (the
            // in-app cancel route's target), renewal date, and — when a
            // period-end cancel is scheduled — the date access ends. Paddle
            // nulls next_billed_at while a cancel is pending, so the two
            // dates are mutually exclusive by construction.
            await prisma.user.update({
              where: { id: mapped.id },
              data: {
                plan: "PRO",
                paddleCustomerId: data.customer_id ?? undefined,
                paddleSubscriptionId: data.id ?? undefined,
                ...detail({
                  subscriptionStatus: data.status,
                  subscriptionRenewsAt: data.next_billed_at ? new Date(data.next_billed_at) : null,
                  subscriptionCancelAt:
                    data.scheduled_change?.action === "cancel" && data.scheduled_change.effective_at
                      ? new Date(data.scheduled_change.effective_at)
                      : null,
                }),
              },
            });
          } else {
            // canceled is terminal — clear the sub id so the in-app cancel
            // route can't target a dead subscription; past_due/paused keep it
            // (the subscription is still recoverable via the portal).
            await prisma.user.update({
              where: { id: mapped.id },
              data: {
                plan: "FREE",
                paddleSubscriptionId: data.status === "canceled" ? null : (data.id ?? undefined),
                ...detail({
                  subscriptionStatus: data.status ?? null,
                  subscriptionRenewsAt: null,
                  subscriptionCancelAt: null,
                }),
              },
            });
            if (data.status === "canceled") {
              await notifyUser(
                mapped.id,
                "billing",
                "Subscription Cancelled",
                "Your subscription has been cancelled. You've been moved to the Free plan.",
                "/settings/account-billing",
              );
            } else if (data.status === "past_due" || data.status === "paused") {
              await notifyUser(
                mapped.id,
                "billing",
                "Payment Issue",
                "Your subscription payment failed. Please update your payment method to restore access.",
                "/settings/account-billing",
              );
            }
          }
        }
      } else if (body.event_type === "transaction.payment_failed") {
        const customerId = body.data.customer_id;
        const user = customerId
          ? await prisma.user.findFirst({ where: { paddleCustomerId: customerId } })
          : null;
        if (user) {
          await notifyUser(
            user.id,
            "billing",
            "Payment Failed",
            "Your latest payment failed. Please update your payment method to keep your plan active.",
            "/settings/account-billing",
          );
        }
      }
      // Other event types (product/price/etc) are acknowledged and ignored.

      await prisma.webhookEvent.create({ data: { id: body.event_id } }).catch((err) => {
        if ((err as { code?: string })?.code !== "P2002") {
          captureError(err, {
            tags: { scope: "paddle.webhook.dedup" },
            extra: { id: body.event_id },
          });
        }
      });
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
            "/settings/account-billing",
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
/**
 * Release Paddle's unique ids from any account other than `keepUserId`.
 *
 * Only ever a no-op in the normal case; when it does fire it means two rows
 * claimed the same subscription or customer, which is worth a human's
 * attention even though the webhook recovers on its own.
 */
async function detachPaddleIdsFromOtherUsers(
  keepUserId: string,
  subscriptionId: string | undefined,
  customerId: string | undefined,
): Promise<void> {
  const claims = [];
  if (subscriptionId) claims.push({ paddleSubscriptionId: subscriptionId });
  if (customerId) claims.push({ paddleCustomerId: customerId });
  if (claims.length === 0) return;

  const { count } = await prisma.user.updateMany({
    where: { id: { not: keepUserId }, OR: claims },
    data: { paddleSubscriptionId: null, paddleCustomerId: null },
  });
  if (count > 0) {
    console.warn(`[PADDLE] detached paddle ids from ${count} other account(s)`);
    captureError(new Error("paddle ids were claimed by another account"), {
      tags: { scope: "paddle.webhook.detach" },
      extra: { keepUserId, subscriptionId, customerId, count },
    });
  }
}

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
