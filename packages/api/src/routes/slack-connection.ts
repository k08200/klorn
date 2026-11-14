/**
 * /api/slack — the signed-in user's Slack connection (docs/providers/slack.md §5).
 *
 * Dark until SLACK_ENABLED (Fastify's default 404, even unauthenticated);
 * every route is requireAuth + cohortGate and acts on the session user's own
 * row only — no id in any path, so there is nothing to reach across users.
 * No response ever carries the signing secret or the user token, and no error
 * echoes them or the request body.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { SLACK_FLAGS, slackLive } from "../config.js";
import { slackAuthTest } from "../slack/auth-test.js";
import {
  disconnectSlack,
  getSlackConnectionStatus,
  saveSlackCredentials,
  setSlackOptInChannels,
  startSlackConnection,
} from "../slack/connection-store.js";
import { renderSlackManifest } from "../slack/manifest.js";
import { cohortGate } from "./cohort-gate.js";
import { darkRouteGate } from "./dark-route-gate.js";
import { rateLimitHook } from "./rate-limit-hook.js";

export const MAX_OPT_IN_CHANNELS = 50;
const CONNECT_LIMIT = { max: 10, timeWindow: "1 hour" } as const;
const MIN_SECRET = 16;
const MAX_SECRET = 128;
const MAX_TOKEN = 255;
const MIN_CHANNEL_ID = 9;
const MAX_CHANNEL_ID = 21;

type Body = Record<string, unknown>;

function asBody(request: FastifyRequest): Body {
  const body = request.body;
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Body) : {};
}

function isAlnum(value: string, extra = ""): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charAt(i);
    const ok =
      (c >= "a" && c <= "z") ||
      (c >= "A" && c <= "Z") ||
      (c >= "0" && c <= "9") ||
      extra.includes(c);
    if (!ok) return false;
  }
  return true;
}

export function validSigningSecret(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const secret = value.trim();
  return secret.length >= MIN_SECRET && secret.length <= MAX_SECRET && isAlnum(secret)
    ? secret
    : null;
}

export type TokenCheck =
  | { ok: true; token: string }
  | { ok: false; code: "bot-token" | "invalid-user-token" };

export function validUserToken(value: unknown): TokenCheck {
  if (typeof value !== "string") return { ok: false, code: "invalid-user-token" };
  const token = value.trim();
  if (token.startsWith("xoxb-")) return { ok: false, code: "bot-token" };
  const valid =
    token.startsWith("xoxp-") &&
    token.length > 10 &&
    token.length <= MAX_TOKEN &&
    isAlnum(token, "-");
  return valid ? { ok: true, token } : { ok: false, code: "invalid-user-token" };
}

/** Public (C…) or private (G…) channel ids, upper-case letters and digits. */
export function validChannelIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_OPT_IN_CHANNELS) return null;
  const ids = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") return null;
    const id = item.trim();
    const shaped =
      id.length >= MIN_CHANNEL_ID &&
      id.length <= MAX_CHANNEL_ID &&
      (id.startsWith("C") || id.startsWith("G")) &&
      id === id.toUpperCase() &&
      isAlnum(id);
    if (!shaped) return null;
    ids.add(id);
  }
  return [...ids];
}

const AUTH_ERRORS: Record<string, { status: number; error: string }> = {
  "slack-rejected-token": { status: 400, error: "Slack did not accept this user token." },
  "slack-unreachable": { status: 502, error: "Could not reach Slack. Try again." },
  "bad-response": { status: 502, error: "Slack answered in a way Klorn could not use." },
  "missing-scopes": { status: 400, error: "The token is missing scopes Klorn needs." },
  "extra-scopes": { status: 400, error: "The token has scopes Klorn must not hold." },
};

async function putCredentials(request: FastifyRequest, reply: FastifyReply) {
  const userId = getUserId(request);
  const body = asBody(request);
  const signingSecret = validSigningSecret(body.signingSecret);
  if (!signingSecret) {
    return reply
      .code(400)
      .send({ error: "That is not a Slack signing secret.", code: "invalid-signing-secret" });
  }
  const token = validUserToken(body.userToken);
  if (!token.ok) {
    const error =
      token.code === "bot-token"
        ? "That is a bot token. Paste the User OAuth Token (xoxp-…)."
        : "That is not a Slack user token (xoxp-…).";
    return reply.code(400).send({ error, code: token.code });
  }
  const auth = await slackAuthTest(token.token);
  if (!auth.ok) {
    const mapped = AUTH_ERRORS[auth.code] ?? { status: 502, error: "Slack check failed." };
    const scopes = "scopes" in auth ? { scopes: auth.scopes } : {};
    return reply.code(mapped.status).send({ error: mapped.error, code: auth.code, ...scopes });
  }
  const saved = await saveSlackCredentials(userId, {
    signingSecret,
    userToken: token.token,
    teamId: auth.teamId,
    slackUserId: auth.slackUserId,
    workspaceUrl: auth.workspaceUrl,
  });
  if (saved === "not-started") {
    return reply.code(409).send({ error: "Start the Slack setup first.", code: "not-started" });
  }
  return getSlackConnectionStatus(userId);
}

export async function slackConnectionRoutes(app: FastifyInstance) {
  app.addHook("onRequest", darkRouteGate(slackLive));
  const connectLimit = rateLimitHook(
    app,
    CONNECT_LIMIT,
    (request) => `slack-connect:user:${getUserId(request)}`,
    "Too many connection attempts. Try again later.",
  );

  app.get("/connection", { preHandler: [requireAuth, cohortGate(SLACK_FLAGS)] }, async (request) =>
    getSlackConnectionStatus(getUserId(request)),
  );

  app.post("/connection", { preHandler: [requireAuth, cohortGate(SLACK_FLAGS)] }, async (request) =>
    startSlackConnection(getUserId(request)),
  );

  app.get(
    "/manifest",
    { preHandler: [requireAuth, cohortGate(SLACK_FLAGS)] },
    async (request, reply) => {
      const status = await getSlackConnectionStatus(getUserId(request));
      if (status.state === "none") {
        return reply.code(409).send({ error: "Start the Slack setup first.", code: "not-started" });
      }
      return reply
        .header("content-type", "text/yaml; charset=utf-8")
        .header("content-disposition", 'attachment; filename="klorn-slack-manifest.yaml"')
        .send(renderSlackManifest(status.requestUrl));
    },
  );

  app.put(
    "/connection/credentials",
    { preHandler: [requireAuth, cohortGate(SLACK_FLAGS), connectLimit] },
    putCredentials,
  );

  app.put(
    "/connection/channels",
    { preHandler: [requireAuth, cohortGate(SLACK_FLAGS)] },
    async (request, reply) => {
      const channelIds = validChannelIds(asBody(request).channelIds);
      if (!channelIds) {
        return reply.code(400).send({
          error: `Up to ${MAX_OPT_IN_CHANNELS} channel IDs like C0123456789.`,
          code: "invalid-channels",
        });
      }
      const userId = getUserId(request);
      if (!(await setSlackOptInChannels(userId, channelIds))) {
        return reply.code(409).send({ error: "Start the Slack setup first.", code: "not-started" });
      }
      return getSlackConnectionStatus(userId);
    },
  );

  app.delete(
    "/connection",
    { preHandler: [requireAuth, cohortGate(SLACK_FLAGS)] },
    async (request, reply) => {
      await disconnectSlack(getUserId(request));
      return reply.code(204).send();
    },
  );
}
