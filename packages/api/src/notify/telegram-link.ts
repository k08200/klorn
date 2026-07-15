/**
 * Telegram account linking — one-time short codes binding a chat to a user.
 *
 * Flow (self-host friendly, no UI dependency):
 * 1. POST /api/telegram/link mints a crypto-random code (10-minute expiry)
 *    and returns the bot deep link `https://t.me/<bot>?start=<code>`.
 * 2. The user taps the link; Telegram sends `/start <code>` to our webhook.
 * 3. consumeTelegramLinkCode binds the chat id and burns the code.
 *
 * Chat ids are stored as strings (Telegram ids exceed 2^31) and are unique
 * per user — re-linking a chat to a new account unbinds the previous owner.
 */

import crypto from "node:crypto";
import { prisma } from "../db.js";
import { getTelegramBotUsername } from "./telegram.js";

export const TELEGRAM_LINK_CODE_TTL_MS = 10 * 60 * 1000;
// 9 random bytes → 12 base64url chars (~72 bits): unguessable within the
// 10-minute window, and stays inside Telegram's /start payload charset
// (A-Za-z0-9_-, max 64 chars).
const LINK_CODE_RANDOM_BYTES = 9;

export interface TelegramLinkCode {
  code: string;
  expiresAt: Date;
  deepLink: string | null;
}

/** Mint a fresh one-time link code for the user (replaces any prior code). */
export async function createTelegramLinkCode(
  userId: string,
  now: Date = new Date(),
): Promise<TelegramLinkCode> {
  const code = crypto.randomBytes(LINK_CODE_RANDOM_BYTES).toString("base64url");
  const expiresAt = new Date(now.getTime() + TELEGRAM_LINK_CODE_TTL_MS);

  await prisma.user.update({
    where: { id: userId },
    data: { telegramLinkCode: code, telegramLinkCodeExpiresAt: expiresAt },
  });

  const botUsername = getTelegramBotUsername();
  return {
    code,
    expiresAt,
    deepLink: botUsername ? `https://t.me/${botUsername}?start=${code}` : null,
  };
}

/**
 * Consume a `/start <code>` payload: bind the chat to the code's owner and
 * burn the code. Expired/unknown codes are rejected without side effects.
 */
export async function consumeTelegramLinkCode(
  code: string,
  chatId: string,
  now: Date = new Date(),
): Promise<{ linked: boolean }> {
  if (!code) return { linked: false };

  const user = await prisma.user.findFirst({
    where: { telegramLinkCode: code, telegramLinkCodeExpiresAt: { gt: now } },
    select: { id: true },
  });
  if (!user) return { linked: false };

  // telegramChatId is unique — unbind any other account holding this chat
  // first so a re-link doesn't blow up on the constraint.
  await prisma.user.updateMany({
    where: { telegramChatId: chatId },
    data: { telegramChatId: null },
  });
  await prisma.user.update({
    where: { id: user.id },
    data: {
      telegramChatId: chatId,
      telegramLinkCode: null,
      telegramLinkCodeExpiresAt: null,
    },
  });
  return { linked: true };
}

/** Unbind the user's Telegram chat and clear any pending link code. */
export async function unlinkTelegram(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      telegramChatId: null,
      telegramLinkCode: null,
      telegramLinkCodeExpiresAt: null,
    },
  });
}

/** The user's linked chat id, or null when Telegram is not linked. */
export async function getLinkedTelegramChatId(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { telegramChatId: true },
  });
  return user?.telegramChatId ?? null;
}

/** Reverse lookup for webhook callbacks: which user owns this chat? */
export async function findUserIdByTelegramChatId(chatId: string): Promise<string | null> {
  const user = await prisma.user.findFirst({
    where: { telegramChatId: chatId },
    select: { id: true },
  });
  return user?.id ?? null;
}
