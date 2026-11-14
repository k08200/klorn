/**
 * POST /api/slack/events/:hookId — the Events API Request URL of one user's
 * internal Slack app (docs/providers/slack.md §3, §6, §12).
 *
 * - Dark until SLACK_ENABLED: Fastify's default 404 before anything runs; in
 *   cohort mode a hook whose owner is outside the cohort is the same 404.
 * - This plugin's own body parser keeps the raw bytes and parses nothing; the
 *   v0 signature is verified over them with the connection's signing secret
 *   (constant time, ±5 minutes) before JSON.parse ever runs.
 * - 256 KiB body cap (413). Rate limits (slack/limits.ts) replace the global
 *   per-address one, which would throttle Slack's shared delivery addresses:
 *   30 failed requests a minute per client address (checked before any
 *   database lookup), and 600 verified requests a minute per hook, i.e. per
 *   workspace (Slack's own ceiling is 30,000 an hour), counted only after the
 *   signature verified so a leaked hook id cannot exhaust it.
 * - url_verification is answered with its challenge. A kept message is stored
 *   with its event_id unique, so a retry or replay is a no-op; judging runs
 *   later on the Slack scheduler, so the answer comes well inside Slack's 3 s.
 * - A verified but unusable body is 400 with X-Slack-No-Retry. Errors and logs
 *   never carry the body, a secret, or message text.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { slackLive, slackOpenTo } from "../config.js";
import { decryptToken } from "../crypto-tokens.js";
import { clientAddressBucket } from "../security/client-address.js";
import { captureError } from "../sentry.js";
import { findSlackHook, type SlackHook, touchSlackHook } from "../slack/connection-store.js";
import { parseSlackEnvelope, type SlackEventCallback } from "../slack/envelope.js";
import {
  deleteSlackMessageCopy,
  ingestSlackMessage,
  markSlackConversationAnswered,
} from "../slack/episodes.js";
import { decideSlackEvent, type SlackDropReason } from "../slack/event-filter.js";
import { WindowCounter } from "../slack/limits.js";
import { type SlackSignatureFailure, verifySlackSignature } from "../slack/signature.js";
import { darkRouteGate, replyRouteNotFound } from "./dark-route-gate.js";

export const SLACK_EVENTS_BODY_LIMIT = 256 * 1024;
/** Verified requests per hook per minute. */
export const SLACK_EVENTS_PER_HOOK_PER_MINUTE = 600;
/** Failed requests (unknown hook, bad signature) per client address per minute. */
export const SLACK_EVENTS_FAILURES_PER_ADDRESS_PER_MINUTE = 30;
const MINUTE_MS = 60_000;
const HOOK_ID_LENGTH = 32;
const HTTP_TOO_MANY = 429;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_SERVER_ERROR = 500;
const LOG_PREFIX = "[slack-events]";
const REJECTION_LOG_INTERVAL_MS = 60 * 60_000;
/** lastEventAt is refreshed at most this often, not on every event. */
const TOUCH_INTERVAL_MS = 60_000;

/** A hook id as minted by startSlackConnection: 32 lowercase hex characters. */
export function isSlackHookId(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== HOOK_ID_LENGTH) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charAt(i);
    if (!((c >= "0" && c <= "9") || (c >= "a" && c <= "f"))) return false;
  }
  return true;
}

function hookIdOf(request: FastifyRequest): string | null {
  const id = (request.params as { hookId?: unknown } | undefined)?.hookId;
  return isSlackHookId(id) ? id : null;
}

export const failuresByAddress = new WindowCounter(
  SLACK_EVENTS_FAILURES_PER_ADDRESS_PER_MINUTE,
  MINUTE_MS,
);
export const verifiedByHook = new WindowCounter(SLACK_EVENTS_PER_HOOK_PER_MINUTE, MINUTE_MS);

type LoggedReason = SlackSignatureFailure | SlackDropReason | "capped" | "not-configured";
const lastReasonLog = new Map<LoggedReason, number>();

/** One log line per reason per hour: never the body, never the hook id. */
function noteReason(kind: "rejected" | "dropped", reason: LoggedReason, now: number): void {
  const last = lastReasonLog.get(reason) ?? 0;
  if (now - last < REJECTION_LOG_INTERVAL_MS) return;
  lastReasonLog.set(reason, now);
  console.warn(`${LOG_PREFIX} ${kind} an event: ${reason} (logged at most hourly per reason)`);
}

/** Test seam. */
export function resetSlackEventLimits(): void {
  failuresByAddress.reset();
  verifiedByHook.reset();
  lastReasonLog.clear();
}

function rejectUnsigned(
  request: FastifyRequest,
  reply: FastifyReply,
  reason: SlackSignatureFailure | "not-configured",
): FastifyReply {
  const now = Date.now();
  failuresByAddress.hit(clientAddressBucket(request), now);
  noteReason("rejected", reason, now);
  return reply.code(HTTP_UNAUTHORIZED).send({ error: "Invalid Slack signature" });
}

function notFound(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  failuresByAddress.hit(clientAddressBucket(request), Date.now());
  return replyRouteNotFound(request, reply);
}

function header(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" ? value : null;
}

function signingSecretOf(hook: SlackHook): string | null {
  if (!hook.signingSecretCipher) return null;
  try {
    return decryptToken(hook.signingSecretCipher);
  } catch (err) {
    captureError(err, { tags: { scope: "slack-events" }, extra: { stage: "decrypt" } });
    return null;
  }
}

async function applyEvent(hook: SlackHook, envelope: SlackEventCallback): Promise<void> {
  if (!hook.teamId || !hook.slackUserId) return;
  const decision = decideSlackEvent(envelope, {
    teamId: hook.teamId,
    slackUserId: hook.slackUserId,
    optInChannelIds: hook.optInChannelIds,
  });
  const event = envelope.event;
  if (!event) return;
  const where = { connectionId: hook.id, channel: event.channel };
  if (decision.action === "keep") {
    const result = await ingestSlackMessage({
      ...where,
      userId: hook.userId,
      eventId: envelope.eventId,
      channelType: event.channelType,
      threadTs: event.threadTs,
      ts: event.ts,
      senderId: event.user ?? "",
      text: event.text,
      mentionsUser: decision.mentionsUser,
    });
    if (result === "capped") noteReason("dropped", "capped", Date.now());
  } else if (decision.action === "own") {
    await markSlackConversationAnswered({ ...where, threadTs: event.threadTs, ts: event.ts });
  } else if (decision.action === "delete") {
    await deleteSlackMessageCopy({ ...where, ts: decision.ts });
  } else if (decision.action === "drop") {
    noteReason("dropped", decision.reason, Date.now());
  }
}

async function answerVerified(
  reply: FastifyReply,
  hook: SlackHook,
  rawBody: Buffer,
): Promise<FastifyReply> {
  const envelope = parseSlackEnvelope(rawBody.toString("utf8"));
  if (envelope.kind === "invalid") {
    reply.header("x-slack-no-retry", "1");
    return reply.code(HTTP_BAD_REQUEST).send({ error: "Unsupported Slack payload" });
  }
  const stale = !hook.lastEventAt || Date.now() - hook.lastEventAt.getTime() >= TOUCH_INTERVAL_MS;
  if (stale || envelope.kind === "url_verification") await touchSlackHook(hook.id);
  if (envelope.kind === "url_verification") {
    return reply.code(HTTP_OK).send({ challenge: envelope.challenge });
  }
  if (envelope.kind === "app_rate_limited") {
    console.warn(`${LOG_PREFIX} Slack reports this app rate-limited (events dropped by Slack)`);
    return reply.code(HTTP_OK).send({ ok: true });
  }
  await applyEvent(hook, envelope);
  return reply.code(HTTP_OK).send({ ok: true });
}

function tooMany(reply: FastifyReply): FastifyReply {
  reply.header("retry-after", "60");
  return reply.code(HTTP_TOO_MANY).send({ error: "Too many requests" });
}

async function handleSlackEvent(request: FastifyRequest, reply: FastifyReply) {
  const now = Date.now();
  if (failuresByAddress.exceeded(clientAddressBucket(request), now)) return tooMany(reply);
  const hookId = hookIdOf(request);
  if (!hookId) return notFound(request, reply);
  const hook = await findSlackHook(hookId);
  if (!hook || !slackOpenTo(hook.userId)) return notFound(request, reply);
  const secret = signingSecretOf(hook);
  if (!secret) return rejectUnsigned(request, reply, "not-configured");
  const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
  const verdict = verifySlackSignature({
    rawBody,
    timestamp: header(request, "x-slack-request-timestamp"),
    signature: header(request, "x-slack-signature"),
    signingSecret: secret,
    nowMs: now,
  });
  if (!verdict.ok) return rejectUnsigned(request, reply, verdict.reason);
  if (!verifiedByHook.hit(hookId, now)) return tooMany(reply);
  try {
    return await answerVerified(reply, hook, rawBody);
  } catch (err) {
    captureError(err, { tags: { scope: "slack-events" }, extra: { stage: "ingest" } });
    return reply.code(HTTP_SERVER_ERROR).send({ error: "Temporarily unavailable" });
  }
}

export async function slackEventsRoutes(app: FastifyInstance) {
  app.addHook("onRequest", darkRouteGate(slackLive));
  // Raw bytes only: nothing parses the body before its signature verified.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });
  app.post(
    "/events/:hookId",
    {
      bodyLimit: SLACK_EVENTS_BODY_LIMIT,
      // The global per-address limit would throttle Slack's shared delivery
      // addresses; this route's own limits are in handleSlackEvent.
      config: { rateLimit: false },
    },
    handleSlackEvent,
  );
}
