/**
 * Telegram delivery for PUSH-tier interrupts — best-effort secondary channel.
 *
 * Called from the sendPushNotification choke point AFTER the shared gates
 * (noise policy, user prefs/quiet hours, rate limit) have passed, so the
 * Telegram channel inherits exactly the same suppression decisions as web
 * push. Failures are contained here: this function never throws.
 *
 * Observability (v1 choice): a structured console line per outcome plus
 * Sentry capture on failure. We intentionally do NOT write PushDeliveryLog
 * rows — those feed web-push receipt/click rates and mixing channels would
 * skew the dogfooding stats. Revisit if Telegram graduates from v1.
 */

import { captureError } from "../sentry.js";
import {
  isTelegramConfigured,
  sendTelegramMessage,
  type TelegramInlineButton,
} from "./telegram.js";
import { getLinkedTelegramChatId } from "./telegram-link.js";

// Telegram rejects callback_data over 64 bytes; uuid + prefix is ~46.
const CALLBACK_DATA_MAX_BYTES = 64;

export interface TelegramPushPayload {
  title: string;
  body: string;
  url?: string;
  attentionItemId?: string;
}

export type TelegramPushOutcome = "sent" | "skipped" | "failed";

/**
 * Build the callback_data for a tier-override button, or null when the id
 * would push the payload past Telegram's 64-byte limit (button is dropped
 * rather than truncated — a truncated id would override the wrong item).
 */
export function buildOverrideCallbackData(
  tier: "QUEUE" | "SILENT",
  attentionItemId: string,
): string | null {
  const data = `ovr:${tier}:${attentionItemId}`;
  if (Buffer.byteLength(data, "utf8") > CALLBACK_DATA_MAX_BYTES) return null;
  return data;
}

/** Send a push payload to the user's linked Telegram chat (best-effort). */
export async function sendTelegramForPush(
  userId: string,
  payload: TelegramPushPayload,
  category: string,
): Promise<TelegramPushOutcome> {
  try {
    if (!isTelegramConfigured()) return "skipped";

    const chatId = await getLinkedTelegramChatId(userId);
    if (!chatId) return "skipped";

    const text = payload.body ? `${payload.title}\n\n${payload.body}` : payload.title;

    const keyboard: TelegramInlineButton[][] = [];
    if (payload.attentionItemId) {
      const queueData = buildOverrideCallbackData("QUEUE", payload.attentionItemId);
      const silentData = buildOverrideCallbackData("SILENT", payload.attentionItemId);
      if (queueData && silentData) {
        keyboard.push([
          { text: "Move to Queue", callback_data: queueData },
          { text: "Silence", callback_data: silentData },
        ]);
      }
    }
    const openUrl = absoluteWebUrl(payload.url);
    if (openUrl) keyboard.push([{ text: "Open Klorn", url: openUrl }]);

    const result = await sendTelegramMessage(
      chatId,
      text,
      keyboard.length ? { inlineKeyboard: keyboard } : undefined,
    );
    if (!result.ok) {
      console.warn(
        `[TELEGRAM] Send failed for ${userId} (${category}): ${result.description ?? "unknown"}`,
      );
      captureError(new Error(`Telegram push delivery failed: ${result.description ?? "unknown"}`), {
        tags: { scope: "telegram.push" },
        extra: { userId, category },
      });
      return "failed";
    }
    // Category only — payload.title carries the sender's identity (PII) and must
    // not reach stdout/log drains.
    console.log(`[TELEGRAM] Sent to linked chat for ${userId} (${category})`);
    return "sent";
  } catch (err) {
    console.warn(`[TELEGRAM] Send error for ${userId} (${category}):`, err);
    captureError(err, { tags: { scope: "telegram.push" }, extra: { userId, category } });
    return "failed";
  }
}

/**
 * Telegram URL buttons require absolute http(s) URLs. Push payloads carry
 * app-relative paths, so resolve against WEB_URL; no base → no button.
 */
function absoluteWebUrl(path: string | undefined): string | null {
  if (!path) return null;
  if (/^https?:\/\//.test(path)) return path;
  const base = process.env.WEB_URL || "";
  if (!base) return null;
  return `${base.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}
