/**
 * The language a READER sees server-composed explanatory text in (tier
 * reasons, the needs-reply reason line).
 *
 * The stored `AutomationConfig.notificationLanguage` is the language of pushes
 * and briefings sent while the user is away. A client that is open on screen
 * knows its own UI language better, so it may name it:
 *
 *   `lang` query → Accept-Language best match → stored notificationLanguage → en
 *
 * Anything outside the seven shipped UI locales is ignored, never an error —
 * an old or foreign client still gets an answer in the stored language.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import {
  getUserNotificationLanguage,
  NOTIFICATION_LANGUAGES,
  type NotificationLanguage,
} from "./notification-strings.js";

/** Querystring schema entry for `lang`; value validation is ours (ignored, not 400). */
export const LANG_QUERY_PROPERTY = { type: "string", maxLength: 64 } as const;

// Accept-Language is client-controlled: bound the work before parsing it.
const MAX_ACCEPT_LANGUAGE_LENGTH = 512;
const MAX_ACCEPT_LANGUAGE_ENTRIES = 32;

/** A supported UI locale from a raw code ("ko", "ko-KR", "zh_Hans"), else null. */
export function parseSupportedLanguage(raw: unknown): NotificationLanguage | null {
  if (typeof raw !== "string" || !raw) return null;
  const base = raw.trim().toLowerCase().split(/[-_]/)[0];
  return (NOTIFICATION_LANGUAGES as readonly string[]).includes(base)
    ? (base as NotificationLanguage)
    : null;
}

function qualityOf(params: string[]): number {
  const q = params.find((p) => p.trim().toLowerCase().startsWith("q="));
  if (!q) return 1;
  const value = Number.parseFloat(q.trim().slice(2));
  return Number.isFinite(value) ? value : 1;
}

/** The highest-q supported language in an Accept-Language header (ties keep header order). */
export function bestAcceptLanguage(
  header: string | string[] | undefined,
): NotificationLanguage | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  const entries = raw
    .slice(0, MAX_ACCEPT_LANGUAGE_LENGTH)
    .split(",")
    .slice(0, MAX_ACCEPT_LANGUAGE_ENTRIES)
    .map((entry, index) => {
      const [tag, ...params] = entry.split(";");
      return { language: parseSupportedLanguage(tag), q: qualityOf(params), index };
    })
    .filter(
      (e): e is { language: NotificationLanguage; q: number; index: number } =>
        e.language !== null && e.q > 0,
    );
  const best = [...entries].sort((a, b) => b.q - a.q || a.index - b.index)[0];
  return best?.language ?? null;
}

/** Resolve the reader language; the stored setting is read only when needed. */
export async function resolveReaderLanguage(input: {
  userId: string;
  lang?: unknown;
  acceptLanguage?: string | string[];
}): Promise<NotificationLanguage> {
  return (
    parseSupportedLanguage(input.lang) ??
    bestAcceptLanguage(input.acceptLanguage) ??
    (await getUserNotificationLanguage(input.userId))
  );
}

/**
 * Route helper: resolve from the request and mark the response as varying by
 * Accept-Language (API responses are no-store today; this keeps any future
 * cache layer from serving one reader's language to another).
 */
export function readerLanguageFor(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
): Promise<NotificationLanguage> {
  reply.header("Vary", "Accept-Language");
  const query = (request.query ?? {}) as { lang?: unknown };
  return resolveReaderLanguage({
    userId,
    lang: query.lang,
    acceptLanguage: request.headers["accept-language"],
  });
}
