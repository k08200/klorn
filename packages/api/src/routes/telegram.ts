/**
 * Telegram linking + bot webhook.
 *
 * - GET    /api/telegram/link    (auth) — link status as `{ linked: boolean }`.
 *          Boolean-only on purpose: the chat id never leaves the server.
 * - POST   /api/telegram/link    (auth) — mint a one-time link code (10-min
 *          expiry) and the bot deep link `https://t.me/<bot>?start=<code>`.
 * - DELETE /api/telegram/link    (auth) — unlink the chat.
 * - POST   /api/telegram/webhook        — Telegram Bot API updates. MUST carry
 *          `X-Telegram-Bot-Api-Secret-Token` matching TELEGRAM_WEBHOOK_SECRET
 *          (set via setWebhook's secret_token param) — 401 otherwise, 503 when
 *          the secret env is unset (CASA baseline: no unauthenticated webhook).
 *
 * Webhook handlers always answer 200 once the secret checks out — Telegram
 * retries non-2xx aggressively and a poison update must not loop forever.
 *
 * v1 handles two update kinds:
 * - `/start <code>` messages   → bind chat to user (consumeTelegramLinkCode)
 * - callback_query `ovr:T:id`  → manual tier override via the same shared
 *   logic as POST /api/inbox/firewall/:id (attention-override.ts), stamping
 *   the poc-judge ground-truth tierReason. Only QUEUE/SILENT are reachable
 *   from buttons — crafted callback data cannot escalate to PUSH/AUTO.
 */

import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { overrideAttentionTier } from "../judge/attention-override.js";
import {
  answerTelegramCallback,
  isTelegramConfigured,
  sendTelegramMessage,
} from "../notify/telegram.js";
import {
  consumeTelegramLinkCode,
  createTelegramLinkCode,
  findUserIdByTelegramChatId,
  getLinkedTelegramChatId,
  unlinkTelegram,
} from "../notify/telegram-link.js";
import { captureError } from "../sentry.js";
import { timingSafeEqualStr } from "../timing-safe-equal.js";

// Override buttons can only move DOWN the interrupt ladder (QUEUE/SILENT).
// Item ids are uuids; 48 chars leaves headroom without inviting abuse.
const OVERRIDE_CALLBACK_RE = /^ovr:(QUEUE|SILENT):([A-Za-z0-9-]{1,48})$/;

interface TelegramChat {
  id?: number | string;
}

interface TelegramUpdate {
  message?: { text?: string; chat?: TelegramChat };
  callback_query?: { id?: string; data?: string; message?: { chat?: TelegramChat } };
}

function chatIdString(chat: TelegramChat | undefined): string | null {
  const id = chat?.id;
  if (id === undefined || id === null) return null;
  return String(id);
}

export async function telegramRoutes(app: FastifyInstance) {
  app.get("/link", { preHandler: requireAuth }, async (request) => {
    const userId = getUserId(request);
    const chatId = await getLinkedTelegramChatId(userId);
    // Boolean-only response — never echo the chat id to the client.
    return { linked: chatId !== null };
  });

  app.post("/link", { preHandler: requireAuth }, async (request, reply) => {
    if (!isTelegramConfigured()) {
      return reply
        .code(503)
        .send({ error: "Telegram is not configured. Set TELEGRAM_BOT_TOKEN on the API." });
    }
    const userId = getUserId(request);
    const { code, expiresAt, deepLink } = await createTelegramLinkCode(userId);
    return { code, expiresAt: expiresAt.toISOString(), deepLink };
  });

  app.delete("/link", { preHandler: requireAuth }, async (request) => {
    const userId = getUserId(request);
    await unlinkTelegram(userId);
    return { linked: false };
  });

  app.post("/webhook", async (request, reply) => {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!secret) {
      return reply.code(503).send({ error: "Telegram webhook not configured" });
    }
    const header = request.headers["x-telegram-bot-api-secret-token"];
    if (typeof header !== "string" || !timingSafeEqualStr(header, secret)) {
      return reply.code(401).send({ error: "Invalid webhook secret" });
    }

    const update = (request.body ?? {}) as TelegramUpdate;
    try {
      if (update.callback_query) {
        await handleCallbackQuery(update.callback_query);
      } else if (update.message) {
        await handleMessage(update.message);
      }
    } catch (err) {
      // Contain everything: a 5xx would make Telegram redeliver the same
      // update in a retry loop. Operators see it via Sentry instead.
      console.error("[TELEGRAM] Webhook handler failed:", err);
      captureError(err, { tags: { scope: "telegram.webhook" } });
    }
    return reply.code(200).send({ ok: true });
  });
}

async function handleMessage(message: NonNullable<TelegramUpdate["message"]>): Promise<void> {
  const chatId = chatIdString(message.chat);
  const text = message.text;
  if (!chatId || typeof text !== "string") return;

  // v1 only understands /start — everything else is silently ignored so the
  // bot never becomes an accidental chat surface.
  const match = text.match(/^\/start(?:\s+(\S+))?\s*$/);
  if (!match) return;

  const code = match[1];
  if (!code) {
    await sendTelegramMessage(
      chatId,
      "To link this chat to Klorn, generate a link code from Klorn (POST /api/telegram/link) and open the t.me link it returns.",
    );
    return;
  }

  const result = await consumeTelegramLinkCode(code, chatId);
  await sendTelegramMessage(
    chatId,
    result.linked
      ? "Linked. PUSH-tier interrupts from your Klorn attention firewall will now arrive here."
      : "That link code is invalid or expired. Generate a fresh one from Klorn and try again.",
  );
}

async function handleCallbackQuery(
  cb: NonNullable<TelegramUpdate["callback_query"]>,
): Promise<void> {
  const callbackId = cb.id;
  if (!callbackId) return;

  const chatId = chatIdString(cb.message?.chat);
  const userId = chatId ? await findUserIdByTelegramChatId(chatId) : null;
  if (!userId) {
    await answerTelegramCallback(callbackId, "This chat is not linked to a Klorn account.");
    return;
  }

  const data = typeof cb.data === "string" ? cb.data : "";
  const match = data.match(OVERRIDE_CALLBACK_RE);
  if (!match) {
    await answerTelegramCallback(callbackId, "Unsupported action.");
    return;
  }

  const [, tier, itemId] = match;
  const result = await overrideAttentionTier(userId, itemId, tier as "QUEUE" | "SILENT");
  await answerTelegramCallback(
    callbackId,
    result.ok
      ? tier === "QUEUE"
        ? "Moved to Queue."
        : "Silenced."
      : "Item not found — it may already be resolved.",
  );
}
