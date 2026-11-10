/**
 * Telegram as a chat surface (TELEGRAM_CHAT_ENABLED, default OFF) — a linked
 * chat's text messages run the SAME locked chat engine as the in-app
 * assistant: same 10-tool whitelist, same create_event interception (the
 * draft is only confirmable in the app), same per-user LLM cost caps.
 * Invoked fire-and-forget from the webhook (Telegram redelivers slow
 * responses), so everything here replies best-effort and never throws.
 * Gates run BEFORE any LLM spend: link → update dedupe → length → paywall
 * posture (requireAppAccess mirror — the webhook carries no session, so the
 * check is inlined) → per-user turn budget.
 */

import type { Prisma } from "@prisma/client";
import { isHardPaywalled } from "../billing/stripe.js";
import { PAYWALL_ENABLED } from "../config.js";
import { prisma } from "../db.js";
import { getUserNotificationLanguage } from "../notify/notification-strings.js";
import { sendTelegramMessage } from "../notify/telegram.js";
import { findUserIdByTelegramChatId } from "../notify/telegram-link.js";
import { captureError } from "../sentry.js";
import { recordDedupKey, wasRecentlyDeduped } from "./agent-dedup.js";
import { runChatTurn } from "./chat-engine.js";

/** Same cap as the HTTP chat route (chat-conversations.ts). */
const MAX_TEXT_LENGTH = 4000;
/** Sliding-window per-user turn budget — half the HTTP route's 20/min: one
 * Telegram thumb is slower than a web form, and every turn is LLM spend. */
const TURNS_PER_MINUTE = 10;
const TURN_WINDOW_MS = 60_000;
/** Telegram redelivers unacked updates; remember seen update_ids briefly. */
const UPDATE_DEDUP_TTL_MS = 10 * 60_000;
/** Telegram hard-caps messages at 4096 chars; stay under with headroom. */
const CHUNK_CHARS = 3900;
/** Same history window as the HTTP chat route. */
const HISTORY_LIMIT = 20;
const TITLE_LENGTH = 60;

export function telegramChatEnabled(): boolean {
  return process.env.TELEGRAM_CHAT_ENABLED === "true";
}

// In-process state below (budget, notice gate, conversation lock) assumes
// the single-instance deploy render.yaml describes; a horizontal scale-out
// needs these moved to shared storage.
const turnTimesByUser = new Map<string, number[]>();

/**
 * Notice sends (unlinked / too-long / rate-limited) get their own per-CHAT
 * gate: the turn budget can't cover them (the unlinked path has no user,
 * and the rate-limited notice fires exactly when the budget is spent), and
 * unbounded they would let one flooding chat burn the bot token's GLOBAL
 * Telegram send ceiling — degrading PUSH delivery for every linked user.
 */
const NOTICE_WINDOW_MS = 5 * 60_000;
const noticeSentAt = new Map<string, number>();

function shouldSendNotice(chatId: string, now: number = Date.now()): boolean {
  const last = noticeSentAt.get(chatId);
  if (last !== undefined && now - last < NOTICE_WINDOW_MS) return false;
  noticeSentAt.set(chatId, now);
  return true;
}

function consumeTurnBudget(userId: string, now: number = Date.now()): boolean {
  const times = (turnTimesByUser.get(userId) ?? []).filter((t) => now - t < TURN_WINDOW_MS);
  if (times.length >= TURNS_PER_MINUTE) {
    turnTimesByUser.set(userId, times);
    return false;
  }
  times.push(now);
  turnTimesByUser.set(userId, times);
  return true;
}

/** Test helper — clears the in-memory turn budget and notice gate. */
export function __resetTelegramChatBudgetForTests(): void {
  turnTimesByUser.clear();
  noticeSentAt.clear();
}

const NOTICES = {
  en: {
    tooLong: "That message is too long — Klorn chat takes up to 4000 characters.",
    rateLimited: "Too many messages at once — give it a minute and try again.",
    paywalled: "An active subscription is required to chat with Klorn.",
    eventDraft: "I prepared this as a calendar draft — open the Klorn app to confirm it.",
  },
  ko: {
    tooLong: "메시지가 너무 깁니다 — Klorn 채팅은 4000자까지 받습니다.",
    rateLimited: "메시지가 너무 잦습니다 — 잠시 후 다시 시도해 주세요.",
    paywalled: "Klorn과 채팅하려면 활성 구독이 필요합니다.",
    eventDraft: "캘린더 초안으로 준비해 두었습니다 — Klorn 앱에서 확인해 주세요.",
  },
  ja: {
    tooLong: "メッセージが長すぎます — Klorn チャットは 4000 文字までです。",
    rateLimited: "メッセージが多すぎます — 少し待ってからもう一度お試しください。",
    paywalled: "Klorn とチャットするには有効なサブスクリプションが必要です。",
    eventDraft: "カレンダーの下書きを用意しました — Klorn アプリで確認してください。",
  },
  zh: {
    tooLong: "消息太长 — Klorn 聊天最多接受 4000 个字符。",
    rateLimited: "消息太频繁 — 请稍等一分钟再试。",
    paywalled: "与 Klorn 聊天需要有效的订阅。",
    eventDraft: "已准备好日历草稿 — 请在 Klorn 应用中确认。",
  },
  de: {
    tooLong: "Die Nachricht ist zu lang — Klorn-Chat nimmt bis zu 4000 Zeichen an.",
    rateLimited: "Zu viele Nachrichten — warte eine Minute und versuche es erneut.",
    paywalled: "Für den Chat mit Klorn ist ein aktives Abo erforderlich.",
    eventDraft: "Als Kalenderentwurf vorbereitet — bestätige ihn in der Klorn-App.",
  },
  es: {
    tooLong: "El mensaje es demasiado largo — el chat de Klorn admite hasta 4000 caracteres.",
    rateLimited: "Demasiados mensajes — espera un minuto e inténtalo de nuevo.",
    paywalled: "Se necesita una suscripción activa para chatear con Klorn.",
    eventDraft: "Lo preparé como borrador de calendario — confírmalo en la app de Klorn.",
  },
  fr: {
    tooLong: "Message trop long — le chat Klorn accepte jusqu'à 4000 caractères.",
    rateLimited: "Trop de messages — attendez une minute et réessayez.",
    paywalled: "Un abonnement actif est requis pour discuter avec Klorn.",
    eventDraft: "Préparé comme brouillon d'agenda — confirmez-le dans l'app Klorn.",
  },
} as const;

/** Unlinked chats have no user, so no language preference — fixed English. */
const UNLINKED_NOTICE =
  "This chat isn't linked to a Klorn account. Open Klorn → Settings → Connections to link it.";

async function noticeFor(userId: string, key: keyof (typeof NOTICES)["en"]): Promise<string> {
  const language = await getUserNotificationLanguage(userId).catch(() => "en" as const);
  const table = NOTICES[language as keyof typeof NOTICES] ?? NOTICES.en;
  return table[key];
}

/** Split a reply for Telegram's message cap, preferring newline boundaries. */
export function chunkTelegramReply(text: string): string[] {
  if (text.length <= CHUNK_CHARS) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > CHUNK_CHARS) {
    const window = rest.slice(0, CHUNK_CHARS);
    const cut = window.lastIndexOf("\n");
    const at = cut > CHUNK_CHARS / 2 ? cut : CHUNK_CHARS;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Serialize per user: findFirst→create is a TOCTOU pair, and two rapid
 * first messages would otherwise fork the user's history into two
 * "telegram" conversations. A (userId, source) unique constraint can't do
 * this — chat/agent sources legitimately hold many conversations per user. */
const conversationLocks = new Map<string, Promise<unknown>>();

async function withConversationLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = conversationLocks.get(userId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  conversationLocks.set(userId, run);
  try {
    return await run;
  } finally {
    if (conversationLocks.get(userId) === run) conversationLocks.delete(userId);
  }
}

async function findOrCreateTelegramConversation(
  userId: string,
): Promise<{ id: string; title: string | null }> {
  return withConversationLock(userId, () => doFindOrCreateTelegramConversation(userId));
}

async function doFindOrCreateTelegramConversation(
  userId: string,
): Promise<{ id: string; title: string | null }> {
  const existing = (await prisma.conversation.findFirst({
    where: { userId, source: "telegram" },
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true },
  })) as { id: string; title: string | null } | null;
  if (existing) return existing;
  const created = (await prisma.conversation.create({
    data: { userId, source: "telegram" },
    select: { id: true, title: true },
  })) as { id: string; title: string | null };
  return created;
}

export async function handleTelegramChatMessage(input: {
  chatId: string;
  text: string;
  updateId?: number;
}): Promise<void> {
  const { chatId, updateId } = input;
  try {
    const text = String(input.text ?? "").trim();
    const userId = await findUserIdByTelegramChatId(chatId);
    if (!userId) {
      if (shouldSendNotice(chatId)) await sendTelegramMessage(chatId, UNLINKED_NOTICE);
      return;
    }
    if (typeof updateId === "number") {
      const dedupKey = `tg-update:${updateId}`;
      if (wasRecentlyDeduped(userId, dedupKey)) return;
      recordDedupKey(userId, dedupKey, UPDATE_DEDUP_TTL_MS);
    }
    if (!text) return;
    if (text.length > MAX_TEXT_LENGTH) {
      if (shouldSendNotice(chatId)) {
        await sendTelegramMessage(chatId, await noticeFor(userId, "tooLong"));
      }
      return;
    }
    // requireAppAccess mirror: the same "who may use the app at all" gate the
    // HTTP chat surface runs, inlined because a webhook has no session.
    const user = (await prisma.user.findUnique({
      where: { id: userId },
      select: { plan: true, role: true },
    })) as { plan: string; role: string | null } | null;
    if (!user) {
      // A dangling link (account deleted after linking) behaves like an
      // unlinked chat — a silent drop would read as the bot being broken.
      if (shouldSendNotice(chatId)) await sendTelegramMessage(chatId, UNLINKED_NOTICE);
      return;
    }
    if (PAYWALL_ENABLED && isHardPaywalled(user.plan, user.role ?? undefined)) {
      if (shouldSendNotice(chatId)) {
        await sendTelegramMessage(chatId, await noticeFor(userId, "paywalled"));
      }
      return;
    }
    if (!consumeTurnBudget(userId)) {
      if (shouldSendNotice(chatId)) {
        await sendTelegramMessage(chatId, await noticeFor(userId, "rateLimited"));
      }
      return;
    }

    const conversation = await findOrCreateTelegramConversation(userId);
    const recent = (await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "desc" },
      take: HISTORY_LIMIT,
      select: { role: true, content: true },
    })) as Array<{ role: string; content: string }>;
    const history = recent
      .reverse()
      .filter((m) => m.role === "USER" || m.role === "ASSISTANT")
      .map((m) => ({
        role: m.role === "USER" ? ("user" as const) : ("assistant" as const),
        content: m.content,
      }));

    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "USER",
        content: text,
        metadata: { source: "telegram" },
      },
    });

    const turn = await runChatTurn({ userId, history, userText: text });
    let reply = turn.reply;
    if (turn.eventDraft) {
      reply += `\n\n${await noticeFor(userId, "eventDraft")}`;
    }

    // Persistence failure must not eat the reply (chat route precedent).
    try {
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          role: "ASSISTANT",
          content: reply,
          metadata: {
            source: "telegram",
            ...(turn.eventDraft ? { eventDraft: { ...turn.eventDraft } } : {}),
            ...(turn.error ? { turnError: turn.error } : {}),
            ...(turn.errorCode ? { turnErrorCode: turn.errorCode } : {}),
          } as Prisma.InputJsonValue,
        },
      });
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          updatedAt: new Date(),
          ...(conversation.title ? {} : { title: text.slice(0, TITLE_LENGTH) }),
        },
      });
    } catch (err) {
      captureError(err, { tags: { scope: "telegram-chat.persist" }, extra: { userId } });
    }

    for (const chunk of chunkTelegramReply(reply)) {
      const sent = await sendTelegramMessage(chatId, chunk);
      if (!sent.ok) {
        console.warn(`[TELEGRAM-CHAT] send failed: ${sent.description ?? "unknown"}`);
        break;
      }
    }
  } catch (err) {
    // Fire-and-forget contract: nothing here may reach the webhook handler.
    captureError(err, { tags: { scope: "telegram-chat.turn" } });
  }
}
