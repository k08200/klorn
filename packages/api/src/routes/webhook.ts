import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { prisma } from "../db.js";
import { sendPushNotification } from "../push.js";
import { stripe } from "../stripe.js";
import { pushNotification } from "../websocket.js";

// In-memory dedup for processed webhook event IDs (TTL: 1 hour)
const processedEvents = new Map<string, number>();
const DEDUP_TTL_MS = 60 * 60 * 1000;

function cleanupProcessedEvents() {
  const now = Date.now();
  for (const [id, ts] of processedEvents) {
    if (now - ts > DEDUP_TTL_MS) processedEvents.delete(id);
  }
}

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

      // Dedup: skip already-processed events
      if (processedEvents.has(event.id)) {
        return { received: true };
      }
      processedEvents.set(event.id, Date.now());
      cleanupProcessedEvents();

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

          if (sub.status === "past_due" || sub.status === "unpaid") {
            const user = await prisma.user.findFirst({ where: { stripeId: custId } });
            if (user) {
              const msg = `Your subscription is ${sub.status}. Please update your payment method to avoid service interruption.`;
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
          console.log(`[STRIPE] Payment failed for customer ${failedCustomer}`);

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
          }
          break;
        }
      }

      return { received: true };
    },
  });
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
  sendPushNotification(userId, { title, body: message, url }).catch((err) =>
    console.warn("[WEBHOOK] push failed", err),
  );
}
