/**
 * Slack Bot Integration for Jigeum
 *
 * Required env vars:
 *   SLACK_BOT_TOKEN    — xoxb-...
 *   SLACK_SIGNING_SECRET — from Slack App settings
 *   SLACK_APP_TOKEN    — xapp-... (for Socket Mode)
 *
 * Install: pnpm add @slack/bolt
 */

import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { wrapUntrusted } from "./untrusted.js";

// Slack message sending (works without @slack/bolt via webhook)
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

const SLACK_REQUEST_MAX_AGE_SEC = 60 * 5;

function verifySlackSignature(req: FastifyRequest): boolean {
  if (!SLACK_SIGNING_SECRET) return false;
  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  const rawBody = (req as unknown as { rawBody?: string }).rawBody;
  if (typeof timestamp !== "string" || typeof signature !== "string" || !rawBody) {
    return false;
  }
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > SLACK_REQUEST_MAX_AGE_SEC) {
    return false;
  }
  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${crypto.createHmac("sha256", SLACK_SIGNING_SECRET).update(base).digest("hex")}`;
  const expectedBuf = Buffer.from(expected, "utf8");
  const signatureBuf = Buffer.from(signature, "utf8");
  if (expectedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

interface SlackMessage {
  channel: string;
  text: string;
  thread_ts?: string;
}

export async function sendSlackMessage(
  msg: SlackMessage,
): Promise<{ ok: boolean; error?: string }> {
  if (SLACK_BOT_TOKEN) {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(msg),
    });
    return res.json() as Promise<{ ok: boolean; error?: string }>;
  }

  if (SLACK_WEBHOOK_URL) {
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: msg.text }),
    });
    return { ok: res.ok };
  }

  return { ok: false, error: "No SLACK_BOT_TOKEN or SLACK_WEBHOOK_URL configured" };
}

export async function listSlackChannels(): Promise<{
  channels: { id: string; name: string }[];
}> {
  if (!SLACK_BOT_TOKEN) {
    return { channels: [] };
  }

  const res = await fetch(
    "https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=100",
    {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    },
  );
  const data = (await res.json()) as {
    ok: boolean;
    channels: { id: string; name: string }[];
  };

  if (!data.ok) return { channels: [] };
  return { channels: data.channels.map((c) => ({ id: c.id, name: c.name })) };
}

export async function readSlackMessages(
  channel: string,
  limit = 10,
): Promise<{ messages: { user: string; text: string; ts: string }[] }> {
  if (!SLACK_BOT_TOKEN) {
    return { messages: [] };
  }

  const url = new URL("https://slack.com/api/conversations.history");
  url.searchParams.set("channel", channel);
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url.href, {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
  });
  const data = (await res.json()) as {
    ok: boolean;
    messages: { user: string; text: string; ts: string }[];
  };

  if (!data.ok) return { messages: [] };
  return {
    messages: data.messages.map((m) => ({
      user: m.user,
      text: wrapUntrusted(m.text, "slack:message"),
      ts: m.ts,
    })),
  };
}

// Slack Event handler (webhook mode for receiving messages)
export async function slackEventRoutes(app: FastifyInstance) {
  // POST /api/slack/events — Slack Events API webhook
  app.post("/events", async (request, reply) => {
    if (!SLACK_SIGNING_SECRET) {
      return reply.code(503).send({ error: "Slack signing secret not configured" });
    }
    if (!verifySlackSignature(request)) {
      return reply.code(401).send({ error: "Invalid Slack signature" });
    }

    const body = request.body as Record<string, unknown>;

    // URL verification challenge
    if (body.type === "url_verification") {
      return reply.send({ challenge: body.challenge });
    }

    // Event callback
    if (body.type === "event_callback") {
      const event = body.event as Record<string, unknown>;

      // Ignore bot messages
      if (event.bot_id) return reply.code(200).send();

      // Handle direct messages or mentions
      if (event.type === "message" || event.type === "app_mention") {
        const text = event.text as string;
        const channel = event.channel as string;
        const threadTs = (event.thread_ts || event.ts) as string;
        const slackUser = (event.user as string) || "unknown";

        console.log(`[SLACK] Message from ${slackUser} in ${channel}: ${text}`);

        await sendSlackMessage({
          channel,
          text: `Noted. I've saved this to your Jigeum dashboard. For now, please use the Jigeum web app for full conversations. Slack auto-reply is coming soon.\n\n> _${text.slice(0, 100)}${text.length > 100 ? "..." : ""}_`,
          thread_ts: threadTs,
        });
      }
    }

    return reply.code(200).send();
  });

  // GET /api/slack/status — Check if Slack is configured
  app.get("/status", async () => {
    return {
      configured: !!(SLACK_BOT_TOKEN || SLACK_WEBHOOK_URL),
      mode: SLACK_BOT_TOKEN ? "bot_token" : SLACK_WEBHOOK_URL ? "webhook" : "none",
    };
  });

  // POST /api/slack/test — Send a test message to verify the integration works
  app.post("/test", async (_request, reply) => {
    if (!SLACK_BOT_TOKEN && !SLACK_WEBHOOK_URL) {
      return reply.code(503).send({ error: "Slack not configured" });
    }
    const channel = process.env.SLACK_DEFAULT_CHANNEL || "#general";
    const result = await sendSlackMessage({
      channel,
      text: "Jigeum test message - Slack integration is working.",
    });
    if (!result.ok) {
      return reply.code(502).send({ error: result.error || "Failed to send" });
    }
    return { success: true, channel };
  });
}

// Tool definitions for Jigeum chat
export const SLACK_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "send_slack_message",
      description: "Send a message to a Slack channel",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Slack channel ID or name (e.g. #general)" },
          text: { type: "string", description: "Message text" },
          thread_ts: {
            type: "string",
            description: "Thread timestamp to reply in thread (optional)",
          },
        },
        required: ["channel", "text"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_slack_channels",
      description: "List available Slack channels",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_slack_messages",
      description: "Read recent messages from a Slack channel",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Slack channel ID" },
          limit: { type: "number", description: "Number of messages to fetch (default 10)" },
        },
        required: ["channel"],
      },
    },
  },
];
