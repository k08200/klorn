/**
 * Telegram Bot API client — thin wrapper over global fetch, no SDK dependency.
 *
 * Self-hosters bring their own bot via BotFather. Environment variables:
 * - TELEGRAM_BOT_TOKEN     — the BotFather token (NEVER logged; redacted from
 *                            every error string before it can reach logs or
 *                            Sentry — same instinct as redactQuotaKey in
 *                            openai.ts).
 * - TELEGRAM_BOT_USERNAME  — bot @username (without @) used to build the
 *                            t.me deep link for account linking.
 *
 * All functions are non-throwing by design: callers get `{ ok, description }`
 * and decide how loud to be. Telegram is a best-effort secondary channel and
 * must never take down the push path.
 */

const TELEGRAM_API_BASE = "https://api.telegram.org";
const REQUEST_TIMEOUT_MS = 10_000;

export interface TelegramInlineButton {
  text: string;
  url?: string;
  callback_data?: string;
}

export interface TelegramCallResult {
  ok: boolean;
  description?: string;
}

/** True when a BotFather token is configured (Telegram channel enabled). */
export function isTelegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN);
}

/** Bot @username (without @) for t.me deep links, or null when unset. */
export function getTelegramBotUsername(): string | null {
  return process.env.TELEGRAM_BOT_USERNAME || null;
}

/**
 * Strip the bot token from any string before it can hit logs or Sentry.
 * Covers both the `/bot<token>/` URL segment (fetch errors embed the URL)
 * and the raw token value itself.
 */
export function redactBotToken(text: string): string {
  let out = text.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>");
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token) out = out.split(token).join("<redacted>");
  return out;
}

async function callTelegram(
  method: string,
  body: Record<string, unknown>,
): Promise<TelegramCallResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, description: "telegram_not_configured" };

  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => null)) as {
      ok?: boolean;
      description?: string;
    } | null;
    if (!res.ok || !json?.ok) {
      return {
        ok: false,
        description: redactBotToken(
          `telegram ${method} failed: status=${res.status} ${json?.description ?? ""}`.trim(),
        ),
      };
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, description: redactBotToken(`telegram ${method} error: ${message}`) };
  }
}

/** Send a plain-text message (optionally with an inline keyboard) to a chat. */
export async function sendTelegramMessage(
  chatId: string,
  text: string,
  opts?: { inlineKeyboard?: TelegramInlineButton[][] },
): Promise<TelegramCallResult> {
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (opts?.inlineKeyboard?.length) {
    body.reply_markup = { inline_keyboard: opts.inlineKeyboard };
  }
  return callTelegram("sendMessage", body);
}

/** Acknowledge an inline-button tap (clears the client-side spinner). */
export async function answerTelegramCallback(
  callbackQueryId: string,
  text?: string,
): Promise<TelegramCallResult> {
  const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
  if (text) body.text = text;
  return callTelegram("answerCallbackQuery", body);
}
