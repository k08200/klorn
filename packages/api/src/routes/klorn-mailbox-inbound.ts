/**
 * POST /api/mailbox/inbound/resend — Resend Inbound's `email.received` webhook
 * for the Klorn mailbox (step E1b of docs/providers/unified-platform-plan.md).
 *
 * - Dark until KLORN_MAILBOX_ENABLED (L6): Fastify's default 404, before
 *   anything else runs. Its own plugin, so the gate cannot reach the Stripe
 *   and Paddle webhooks in routes/webhook.ts.
 * - Flag on with the secret, the inbound API key or the domain unset: 503 and
 *   an error naming the variable, so Resend retries while it is fixed.
 * - `resend.webhooks.verify` over the raw body the global JSON parser keeps
 *   (index.ts) and the three Svix headers: a bad or missing signature is 401.
 * - Only `email.received` is handled; any other type is 204.
 * - Its own rate limit: Svix delivers from a few addresses, and the global 100
 *   a minute per address would answer 429 to a burst.
 * - Delivery is mail/klorn-inbound.ts: 503 when any copy needs a retry, 200
 *   once every copy is stored or deliberately dropped.
 * - The log line carries the email_id and counts only.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Resend, type WebhookEventPayload } from "resend";
import { klornInboundConfig } from "../config.js";
import {
  deliverInboundEmail,
  errorKind,
  type InboundOutcome,
  isResendEmailId,
} from "../mail/klorn-inbound.js";
import { captureError } from "../sentry.js";
import { darkRouteGate } from "./dark-route-gate.js";

export const KLORN_INBOUND_RATE_LIMIT = { max: 600, timeWindow: "1 minute" } as const;
/** One Resend call (content or forward); past it the delivery is retried. */
export const RESEND_TIMEOUT_MS = 10_000;

const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_UNAUTHORIZED = 401;
const HTTP_SERVICE_UNAVAILABLE = 503;
const LOG_PREFIX = "[klorn-inbound]";

function headerValue(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function verifiedEvent(
  resend: Resend,
  request: FastifyRequest,
  webhookSecret: string,
): WebhookEventPayload | null {
  const id = headerValue(request, "svix-id");
  const timestamp = headerValue(request, "svix-timestamp");
  const signature = headerValue(request, "svix-signature");
  const payload = (request as unknown as { rawBody?: unknown }).rawBody;
  if (!id || !timestamp || !signature || typeof payload !== "string") return null;
  try {
    return resend.webhooks.verify({
      payload,
      headers: { id, timestamp, signature },
      webhookSecret,
    });
  } catch {
    return null;
  }
}

function logOutcome(emailId: string, outcome: InboundOutcome): void {
  const line = `${LOG_PREFIX} email_id=${emailId} stored=${outcome.stored} dropped=${outcome.dropped} forwarded=${outcome.forwarded}`;
  if (outcome.retry) console.warn(`${line} retry=${outcome.retry}`);
  else console.info(line);
}

export function klornMailboxInboundRoutes(opts: {
  gate: () => boolean;
  /** Tests pass a client whose network calls are mocked. */
  createResend?: (apiKey: string) => Resend;
  resendTimeoutMs?: number;
}): (app: FastifyInstance) => Promise<void> {
  const createResend = opts.createResend ?? ((apiKey: string) => new Resend(apiKey));
  const timeoutMs = opts.resendTimeoutMs ?? RESEND_TIMEOUT_MS;

  async function inboundHandler(request: FastifyRequest, reply: FastifyReply) {
    const config = klornInboundConfig();
    if (!config.ok) {
      console.error(`${LOG_PREFIX} not configured: ${config.missing.join(", ")} unset`);
      return reply.code(HTTP_SERVICE_UNAVAILABLE).send({ error: "Inbound mail is not configured" });
    }
    const resend = createResend(config.apiKey);
    const event = verifiedEvent(resend, request, config.webhookSecret);
    if (!event) return reply.code(HTTP_UNAUTHORIZED).send({ error: "Invalid signature" });
    if (event.type !== "email.received") return reply.code(HTTP_NO_CONTENT).send();

    const data: unknown = event.data;
    const rawId = (data as { email_id?: unknown } | null)?.email_id;
    const emailId = isResendEmailId(rawId) ? rawId : "invalid";
    let outcome: InboundOutcome;
    try {
      outcome = await deliverInboundEmail(
        data,
        { domain: config.domain, forwardTo: config.forwardTo, timeoutMs },
        resend.emails.receiving,
      );
    } catch (err) {
      // A lookup failed (the database, most likely): Resend retries.
      captureError(new Error(`Klorn inbound delivery failed: ${errorKind(err)}`), {
        tags: { scope: "klorn-inbound.lookup" },
        extra: { emailId },
      });
      outcome = { stored: 0, dropped: 0, forwarded: 0, retry: "lookup" };
    }
    logOutcome(emailId, outcome);
    const counts = {
      stored: outcome.stored,
      dropped: outcome.dropped,
      forwarded: outcome.forwarded,
    };
    if (outcome.retry) {
      return reply
        .code(HTTP_SERVICE_UNAVAILABLE)
        .send({ error: "Temporarily unavailable", ...counts });
    }
    return reply.code(HTTP_OK).send({ received: true, ...counts });
  }

  return async function routes(app: FastifyInstance) {
    app.addHook("onRequest", darkRouteGate(opts.gate));
    app.post(
      "/inbound/resend",
      { config: { rateLimit: KLORN_INBOUND_RATE_LIMIT } },
      inboundHandler,
    );
  };
}
