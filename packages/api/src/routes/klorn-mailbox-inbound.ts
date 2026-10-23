/**
 * POST /api/mailbox/inbound/resend — Resend Inbound's `email.received` webhook
 * for the Klorn mailbox (step E1b of docs/providers/unified-platform-plan.md).
 *
 * - Dark until KLORN_MAILBOX_ENABLED (L6): Fastify's default 404, before
 *   anything else runs. Its own plugin, so the gate cannot reach the Stripe
 *   and Paddle webhooks in routes/webhook.ts.
 * - Flag on with the secret (or one under 16 bytes), the inbound API key or the
 *   domain unusable: 503 and an error naming the variable, so Resend retries.
 * - The Svix signature is verified over the raw body the global JSON parser
 *   keeps (index.ts) before the client holding the full-access key exists. A
 *   bad or missing signature is 401, with its reason (missing-headers,
 *   bad-signature, stale-timestamp) logged at most once an hour per reason.
 * - Only `email.received` is handled; any other type is 204.
 * - Its own rate limit (Svix delivers from a few addresses, and the global 100
 *   a minute per address would answer 429 to a burst) and a 256 KiB body
 *   limit: the event is metadata only.
 * - Delivery is mail/klorn-inbound.ts, under one deadline per request: 503 when
 *   any copy needs a retry, 200 once every copy is stored or deliberately dropped.
 * - The log line carries the email_id and counts only.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Resend, type WebhookEventPayload } from "resend";
import { klornInboundConfig } from "../config.js";
import {
  deliverInboundEmail,
  errorKind,
  type InboundContext,
  type InboundOutcome,
  isResendEmailId,
} from "../mail/klorn-inbound.js";
import { NOTICES_PER_HOUR, noticeBucket } from "../mail/klorn-inbound-notice.js";
import type { InboundRuntime } from "../mail/klorn-inbound-outcome.js";
import { createInboundReporter, type InboundReporter } from "../mail/klorn-inbound-report.js";
import { inboundResendApi } from "../mail/klorn-inbound-resend.js";
import { BoundedSlots } from "../mail/klorn-inbound-slots.js";
import { darkRouteGate } from "./dark-route-gate.js";

export const KLORN_INBOUND_RATE_LIMIT = { max: 600, timeWindow: "1 minute" } as const;
export const KLORN_INBOUND_BODY_LIMIT = 256 * 1024;
/** One Resend call (content or notice); past it the delivery is retried. */
export const RESEND_TIMEOUT_MS = 10_000;
/** The whole request; past it the answer is 503 and no new work starts. */
export const INBOUND_DEADLINE_MS = 12_000;
/** Concurrent content fetches and stores, process-wide. */
const DELIVERY_CONCURRENCY = 4;
/** Deliveries waiting for a slot; past it the answer is 503 at once (Resend retries). */
const MAX_QUEUED_DELIVERIES = 32;
/** The deadline's own timer waits this much longer, so the per-call budgets answer first. */
const DEADLINE_GRACE_MS = 500;

const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_UNAUTHORIZED = 401;
const HTTP_SERVICE_UNAVAILABLE = 503;
const LOG_PREFIX = "[klorn-inbound]";

/**
 * Verifies signatures only: `webhooks.verify` reads no key, and the Resend
 * constructor wants a non-empty one. The client with the real key is built
 * only for an event that verified.
 */
const SIGNATURE_VERIFIER = new Resend("signature-verification-only");

type Verification =
  | { ok: true; event: WebhookEventPayload }
  | { ok: false; reason: "missing-headers" | "bad-signature" | "stale-timestamp" };

function headerValue(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function verifyEvent(request: FastifyRequest, webhookSecret: string): Verification {
  const id = headerValue(request, "svix-id");
  const timestamp = headerValue(request, "svix-timestamp");
  const signature = headerValue(request, "svix-signature");
  const payload = (request as unknown as { rawBody?: unknown }).rawBody;
  if (!id || !timestamp || !signature || typeof payload !== "string") {
    return { ok: false, reason: "missing-headers" };
  }
  try {
    const headers = { id, timestamp, signature };
    return {
      ok: true,
      event: SIGNATURE_VERIFIER.webhooks.verify({ payload, headers, webhookSecret }),
    };
  } catch (err) {
    // standardwebhooks names a timestamp outside its 5-minute tolerance.
    const stale = err instanceof Error && /timestamp/i.test(err.message);
    return { ok: false, reason: stale ? "stale-timestamp" : "bad-signature" };
  }
}

function logOutcome(emailId: string, outcome: InboundOutcome): void {
  const line = `${LOG_PREFIX} email_id=${emailId} stored=${outcome.stored} dropped=${outcome.dropped} notified=${outcome.notified}`;
  if (outcome.retry) console.warn(`${line} retry=${outcome.retry}`);
  else console.info(line);
}

const DEADLINE_OUTCOME: InboundOutcome = {
  stored: 0,
  dropped: 0,
  notified: 0,
  pending: 1,
  retry: "deadline",
};

/** The delivery, or a retry once the deadline passes (the work may finish in the background). */
async function withinDeadline(
  delivery: Promise<InboundOutcome>,
  deadlineMs: number,
): Promise<InboundOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<InboundOutcome>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE_OUTCOME), deadlineMs + DEADLINE_GRACE_MS);
  });
  try {
    return await Promise.race([delivery, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function deliverSafely(
  event: WebhookEventPayload,
  emailId: string,
  ctx: InboundContext,
  reporter: InboundReporter,
): Promise<InboundOutcome> {
  try {
    return await deliverInboundEmail(event, ctx);
  } catch (err) {
    // A lookup failed (the database, most likely): Resend retries.
    reporter.report("lookup", { emailId, kind: errorKind(err) });
    return { ...DEADLINE_OUTCOME, retry: "lookup" };
  }
}

export function klornMailboxInboundRoutes(opts: {
  gate: () => boolean;
  /** Tests pass a client whose network calls are mocked. */
  createResend?: (apiKey: string) => Resend;
  resendTimeoutMs?: number;
  deadlineMs?: number;
  noticesPerHour?: number;
  now?: () => number;
}): (app: FastifyInstance) => Promise<void> {
  const createResend = opts.createResend ?? ((apiKey: string) => new Resend(apiKey));
  const timeoutMs = opts.resendTimeoutMs ?? RESEND_TIMEOUT_MS;
  const deadlineMs = opts.deadlineMs ?? INBOUND_DEADLINE_MS;
  const now = opts.now ?? Date.now;
  // One per registered route: process-wide in production (index.ts registers it once).
  const reporter = createInboundReporter(now);
  const runtime: InboundRuntime = {
    noticeBucket: noticeBucket(opts.noticesPerHour ?? NOTICES_PER_HOUR, now),
    noticeSlots: new BoundedSlots(1, MAX_QUEUED_DELIVERIES),
    deliverySlots: new BoundedSlots(DELIVERY_CONCURRENCY, MAX_QUEUED_DELIVERIES),
  };

  async function inboundHandler(request: FastifyRequest, reply: FastifyReply) {
    const deadlineAt = now() + deadlineMs;
    const config = klornInboundConfig();
    if (!config.ok) {
      const missing = config.missing.join(", ");
      reporter.log(
        "error",
        `config:${missing}`,
        `${LOG_PREFIX} not configured: ${missing} unset or unusable`,
      );
      return reply.code(HTTP_SERVICE_UNAVAILABLE).send({ error: "Inbound mail is not configured" });
    }
    for (const warning of config.warnings)
      reporter.log("error", `config:${warning}`, `${LOG_PREFIX} ${warning}`);

    const verification = verifyEvent(request, config.webhookSecret);
    if (!verification.ok) {
      const { reason } = verification;
      reporter.log("warn", `signature:${reason}`, `${LOG_PREFIX} rejected reason=${reason}`);
      return reply.code(HTTP_UNAUTHORIZED).send({ error: "Invalid signature" });
    }
    const { event } = verification;
    if (event.type !== "email.received") return reply.code(HTTP_NO_CONTENT).send();

    const rawId = (event.data as { email_id?: unknown } | null)?.email_id;
    const emailId = isResendEmailId(rawId) ? rawId : "invalid";
    const ctx: InboundContext = {
      domain: config.domain,
      forwardTo: config.forwardTo,
      api: inboundResendApi(createResend(config.apiKey)),
      reporter,
      runtime,
      timeoutMs,
      deadlineAt,
      now,
    };
    const outcome = await withinDeadline(deliverSafely(event, emailId, ctx, reporter), deadlineMs);
    logOutcome(emailId, outcome);
    const counts = {
      stored: outcome.stored,
      dropped: outcome.dropped,
      notified: outcome.notified,
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
      { bodyLimit: KLORN_INBOUND_BODY_LIMIT, config: { rateLimit: KLORN_INBOUND_RATE_LIMIT } },
      inboundHandler,
    );
  };
}
