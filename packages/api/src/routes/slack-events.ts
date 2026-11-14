/**
 * POST /api/slack/events/:hookId — the Events API Request URL of one user's
 * internal Slack app (docs/providers/slack.md §3, §6, §12).
 *
 * - Dark until SLACK_ENABLED: Fastify's default 404 before anything runs; in
 *   cohort mode a hook whose owner is outside the cohort is the same 404.
 * - This plugin's own body parser keeps the raw bytes and parses nothing; the
 *   v0 signature is verified over them with the connection's signing secret
 *   (constant time, ±5 minutes) before JSON.parse ever runs.
 * - 256 KiB body cap (413) and 600 requests a minute per hook, i.e. per
 *   workspace (Slack's own ceiling is 30,000 an hour).
 * - url_verification is answered with its challenge. A kept message is stored
 *   with its event_id unique, so a retry or replay is a no-op; judging runs
 *   later on the Slack scheduler, so the answer comes well inside Slack's 3 s.
 * - A verified but unusable body is 400 with X-Slack-No-Retry. Errors and logs
 *   never carry the body, a secret, or message text.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { slackLive, slackOpenTo } from "../config.js";
import { decryptToken } from "../crypto-tokens.js";
import { captureError } from "../sentry.js";
import { findSlackHook, type SlackHook, touchSlackHook } from "../slack/connection-store.js";
import { parseSlackEnvelope, type SlackEventCallback } from "../slack/envelope.js";
import {
  deleteSlackMessageCopy,
  ingestSlackMessage,
  markSlackConversationAnswered,
} from "../slack/episodes.js";
import { decideSlackEvent } from "../slack/event-filter.js";
import { type SlackSignatureFailure, verifySlackSignature } from "../slack/signature.js";
import { darkRouteGate, replyRouteNotFound } from "./dark-route-gate.js";

export const SLACK_EVENTS_BODY_LIMIT = 256 * 1024;
export const SLACK_EVENTS_RATE_LIMIT = { max: 600, timeWindow: "1 minute" } as const;
const HOOK_ID_LENGTH = 32;
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

/** Per hook, i.e. per workspace; malformed ids share one bucket. */
export function slackEventsRateKey(request: FastifyRequest): string {
  return `slack-events:${hookIdOf(request) ?? "invalid"}`;
}

const lastRejectionLog = new Map<SlackSignatureFailure, number>();
function noteRejection(reason: SlackSignatureFailure, now: number): void {
  const last = lastRejectionLog.get(reason) ?? 0;
  if (now - last < REJECTION_LOG_INTERVAL_MS) return;
  lastRejectionLog.set(reason, now);
  console.warn(`${LOG_PREFIX} rejected a request: ${reason} (logged at most hourly per reason)`);
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
    await ingestSlackMessage({
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
  } else if (decision.action === "own") {
    await markSlackConversationAnswered({ ...where, threadTs: event.threadTs });
  } else if (decision.action === "delete") {
    await deleteSlackMessageCopy({ ...where, ts: decision.ts });
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

async function handleSlackEvent(request: FastifyRequest, reply: FastifyReply) {
  const hookId = hookIdOf(request);
  if (!hookId) return replyRouteNotFound(request, reply);
  const hook = await findSlackHook(hookId);
  if (!hook || !slackOpenTo(hook.userId)) return replyRouteNotFound(request, reply);
  const secret = signingSecretOf(hook);
  if (!secret) {
    return reply.code(HTTP_UNAUTHORIZED).send({ error: "Slack connection is not configured" });
  }
  const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
  const now = Date.now();
  const verdict = verifySlackSignature({
    rawBody,
    timestamp: header(request, "x-slack-request-timestamp"),
    signature: header(request, "x-slack-signature"),
    signingSecret: secret,
    nowMs: now,
  });
  if (!verdict.ok) {
    noteRejection(verdict.reason, now);
    return reply.code(HTTP_UNAUTHORIZED).send({ error: "Invalid Slack signature" });
  }
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
      config: { rateLimit: { ...SLACK_EVENTS_RATE_LIMIT, keyGenerator: slackEventsRateKey } },
    },
    handleSlackEvent,
  );
}
