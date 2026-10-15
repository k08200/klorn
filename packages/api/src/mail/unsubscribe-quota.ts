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

import { isIP } from "node:net";
import { prisma } from "../db.js";
import { isSafePushEndpoint } from "../notify/is-safe-push-endpoint.js";
import { captureError } from "../sentry.js";

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

/** Longest DNS name; anything longer is not a real target. */
const MAX_HOST_LENGTH = 253;

/**
 * The domain a target is counted under: its last two labels, or three when it
 * sits under a country code's second level. An approximation of the
 * registrable domain without a public-suffix list — it only has to stop a
 * sender from multiplying one victim's cap by minting subdomains. Null for an
 * IP literal (one address has many spellings, each its own bucket), an empty
 * label, or an over-long name: none of those is a mailing list.
 */
export function targetDomain(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return null;
  }
  if (!host || host.length > MAX_HOST_LENGTH) return null;
  if (isIP(host.replace(/^\[|\]$/g, "")) !== 0) return null;
  const labels = host.split(".");
  if (labels.some((label) => label.length === 0)) return null;
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
      // Only an OLDER day rolls over: a caller whose clock is behind (or that
      // computed its day just before midnight) must not reset today's count.
      OR: [{ autoUnsubscribeDay: null }, { autoUnsubscribeDay: { lt: day } }],
    },
    data: { autoUnsubscribeDay: day, autoUnsubscribeCount: 1 },
  });
  if (rolled.count === 1) return true;
  // Lost the rollover to a concurrent sync, or today's cap is spent.
  return (await increment()).count === 1;
}

/**
 * One slot of a shared counter ("host:<domain>" or "global"). A single
 * statement: insert, roll over an older day, or increment while under the cap
 * — and return nothing when the cap is reached or the stored day is newer than
 * the caller's (ISO dates sort as strings).
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
    WHERE "UnsubscribeQuota"."day" < EXCLUDED."day"
       OR ("UnsubscribeQuota"."day" = EXCLUDED."day" AND "UnsubscribeQuota"."count" < ${cap})
    RETURNING "count"`;
  return rows.length === 1;
}

// A tripped shared cap is the signature of someone abusing the trigger, so it
// is reported — once per target per day per process, or it would page on
// every refused mail. The domain goes to Sentry extra, never into the log line.
const reportedTrips = new Set<string>();

export function resetCapTripReportsForTests(): void {
  reportedTrips.clear();
}

function reportCapTrip(reason: "host-cap" | "global-cap", domain: string | null, day: string): void {
  const key = `${day}:${reason}:${domain ?? "*"}`;
  if (reportedTrips.has(key)) return;
  if (reportedTrips.size > 10_000) reportedTrips.clear();
  reportedTrips.add(key);
  captureError(new Error(`auto-unsubscribe ${reason} reached`), {
    tags: { scope: "auto-unsubscribe.cap" },
    extra: { reason, domain, day },
  });
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
    reportCapTrip("host-cap", domain, day);
    return { ok: false, reason: "host-cap" };
  }
  if (!(await reserveSharedSlot("global", day, autoUnsubscribeGlobalCap()))) {
    reportCapTrip("global-cap", null, day);
    return { ok: false, reason: "global-cap" };
  }
  return { ok: true };
}
