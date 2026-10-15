/**
 * Caps on automatic one-click unsubscribes (AUTO_UNSUBSCRIBE_ENABLED).
 *
 * The trigger — SILENT tier + the deterministic marketing signal + an RFC 8058
 * target — is something any sender can craft, and the POST goes out from
 * Klorn's server. Uncapped, that is a confused deputy at fleet scale: one
 * campaign aimed at many users makes Klorn POST to a host of the sender's
 * choosing once per user per message (security review 2026-08-27). Three
 * daily caps (UTC day) bound it, checked in this order:
 *
 *   1. per user   — AUTO_UNSUBSCRIBE_USER_DAILY_CAP   (default 20, max 100)
 *   2. per target — AUTO_UNSUBSCRIBE_HOST_DAILY_CAP   (default 50, max 1000),
 *                   across all users, keyed by the target's registrable domain
 *                   so a spread of subdomains counts as one target
 *   3. fleet-wide — AUTO_UNSUBSCRIBE_GLOBAL_DAILY_CAP (default 1000, max 10000)
 *
 * Every slot is taken with one atomic conditional write, so concurrent syncs
 * cannot overshoot a cap. A slot taken before a later cap refuses stays taken:
 * the error is always toward fewer POSTs, never more. Unsafe targets are
 * refused before anything is written.
 */

import { prisma } from "../db.js";
import { isSafePushEndpoint } from "../notify/is-safe-push-endpoint.js";

function capFromEnv(name: string, fallback: number, max: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(max, Math.floor(parsed));
}

export const autoUnsubscribeUserCap = () => capFromEnv("AUTO_UNSUBSCRIBE_USER_DAILY_CAP", 20, 100);
export const autoUnsubscribeHostCap = () => capFromEnv("AUTO_UNSUBSCRIBE_HOST_DAILY_CAP", 50, 1000);
export const autoUnsubscribeGlobalCap = () =>
  capFromEnv("AUTO_UNSUBSCRIBE_GLOBAL_DAILY_CAP", 1000, 10_000);

/** The caps' window: one UTC calendar day. */
export function quotaDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Second-level labels under a two-letter country code (co.uk, co.kr, com.au …). */
const SECOND_LEVEL_LABELS = new Set([
  "ac",
  "co",
  "com",
  "edu",
  "go",
  "gov",
  "ne",
  "net",
  "or",
  "org",
]);

/**
 * The domain a target is counted under: its last two labels, or three when it
 * sits under a country code's second level. An approximation of the
 * registrable domain without a public-suffix list — it only has to stop a
 * sender from multiplying one victim's cap by minting subdomains.
 */
export function targetDomain(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
  if (!host) return null;
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const tld = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  const take = tld.length === 2 && SECOND_LEVEL_LABELS.has(second) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** One of the user's daily slots; the day rolls over on the user row. */
async function reserveUserSlot(userId: string, day: string, cap: number): Promise<boolean> {
  const increment = () =>
    prisma.user.updateMany({
      where: { id: userId, autoUnsubscribeDay: day, autoUnsubscribeCount: { lt: cap } },
      data: { autoUnsubscribeCount: { increment: 1 } },
    });
  if ((await increment()).count === 1) return true;
  const rolled = await prisma.user.updateMany({
    where: {
      id: userId,
      OR: [{ autoUnsubscribeDay: null }, { autoUnsubscribeDay: { not: day } }],
    },
    data: { autoUnsubscribeDay: day, autoUnsubscribeCount: 1 },
  });
  if (rolled.count === 1) return true;
  // Lost the rollover to a concurrent sync, or today's cap is spent.
  return (await increment()).count === 1;
}

/**
 * One slot of a shared counter ("host:<domain>" or "global"). A single
 * statement: insert, roll over a stale day, or increment while under the cap —
 * and return nothing when the cap is reached.
 */
async function reserveSharedSlot(key: string, day: string, cap: number): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO "UnsubscribeQuota" ("key", "day", "count", "updatedAt")
    VALUES (${key}, ${day}, 1, NOW())
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "UnsubscribeQuota"."day" = EXCLUDED."day"
                     THEN "UnsubscribeQuota"."count" + 1 ELSE 1 END,
      "day" = EXCLUDED."day",
      "updatedAt" = NOW()
    WHERE "UnsubscribeQuota"."day" <> EXCLUDED."day" OR "UnsubscribeQuota"."count" < ${cap}
    RETURNING "count"`;
  return rows.length === 1;
}

export type AutoUnsubscribeQuota =
  | { ok: true }
  | { ok: false; reason: "unsafe-endpoint" | "user-cap" | "host-cap" | "global-cap" };

/**
 * Take one slot from each cap for this automatic unsubscribe, or say which cap
 * refused. Throws on a database error — the caller must treat that as "no".
 */
export async function reserveAutoUnsubscribe(
  userId: string,
  url: string,
  now: Date = new Date(),
): Promise<AutoUnsubscribeQuota> {
  const domain = isSafePushEndpoint(url) ? targetDomain(url) : null;
  if (!domain) return { ok: false, reason: "unsafe-endpoint" };
  const day = quotaDay(now);
  if (!(await reserveUserSlot(userId, day, autoUnsubscribeUserCap()))) {
    return { ok: false, reason: "user-cap" };
  }
  if (!(await reserveSharedSlot(`host:${domain}`, day, autoUnsubscribeHostCap()))) {
    return { ok: false, reason: "host-cap" };
  }
  if (!(await reserveSharedSlot("global", day, autoUnsubscribeGlobalCap()))) {
    return { ok: false, reason: "global-cap" };
  }
  return { ok: true };
}
