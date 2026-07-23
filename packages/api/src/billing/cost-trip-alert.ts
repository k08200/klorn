/**
 * Cost-cap trip visibility.
 *
 * Tripping the global daily ceiling used to be silent: the judge degraded to
 * keyword-fallback, PUSH notifications died, and neither founder nor users
 * saw any signal. This module makes every ceiling trip loud, exactly once
 * per UTC day per scope:
 *
 *  1. console.error + Sentry captureError (the repo's standard alert pair),
 *  2. one Notification row per ADMIN user, deduped by a day-scoped
 *     `dedupeKey` — the same winner-only P2002 idiom as
 *     ensureDailyBriefingNotification (pim/briefing.ts),
 *  3. an in-memory snapshot exposed on GET /api/admin/flags (`costGuard`).
 *
 * Alerting must never break or slow the LLM call path: notifyCostCapTrip
 * never throws, and cost-guard.ts invokes it fire-and-forget.
 */

import { captureError } from "../sentry.js";

export interface CostCapTripInput {
  scope: "global" | "user";
  /** Required for scope "user"; the user whose cap tripped. */
  userId?: string;
  usedCents: number;
  capCents: number;
}

export interface CostTripSnapshot {
  dayKey: string;
  globalTrippedToday: boolean;
  userTrippedToday: string[];
}

function currentUtcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// In-memory, single-instance state (same deliberate tradeoff as the global
// spend accumulator in cost-guard.ts): a restart forgets today's trips, but
// the DB dedupeKey still prevents duplicate admin notifications.
const tripState = {
  dayKey: currentUtcDayKey(),
  global: false,
  users: new Set<string>(),
};

function rollDayIfNeeded(): void {
  const today = currentUtcDayKey();
  if (tripState.dayKey !== today) {
    tripState.dayKey = today;
    tripState.global = false;
    tripState.users.clear();
  }
}

/** Today's trip state for the admin flags snapshot (/api/admin/flags). */
export function getCostTripSnapshot(): CostTripSnapshot {
  rollDayIfNeeded();
  return {
    dayKey: tripState.dayKey,
    globalTrippedToday: tripState.global,
    userTrippedToday: [...tripState.users],
  };
}

/**
 * Surface a cost-cap trip. At-most-once per day per scope (per user for the
 * per-user cap) via the in-memory mark; the DB dedupeKey backstops races
 * across instances/restarts. NEVER throws.
 */
export async function notifyCostCapTrip(input: CostCapTripInput): Promise<void> {
  try {
    rollDayIfNeeded();
    if (input.scope === "global") {
      if (tripState.global) return;
      tripState.global = true;
    } else {
      if (!input.userId || tripState.users.has(input.userId)) return;
      tripState.users.add(input.userId);
    }

    const usedRounded = Math.round(input.usedCents * 100) / 100;
    const label =
      input.scope === "global"
        ? "Global daily LLM cost ceiling tripped"
        : `Daily LLM cost cap tripped for user ${input.userId}`;
    const message = `${label}: ${usedRounded}¢/${input.capCents}¢ on ${tripState.dayKey}. Paid LLM calls in this scope are blocked (judge degrades to keyword fallback) until UTC midnight.`;

    console.error(`[cost-guard] ${message}`);
    captureError(new Error(`Cost cap tripped (${input.scope})`), {
      tags: { scope: "cost-guard.cap-trip", capScope: input.scope },
      extra: {
        userId: input.userId ?? null,
        usedCents: input.usedCents,
        capCents: input.capCents,
        dayKey: tripState.dayKey,
      },
    });

    await createAdminTripNotifications(input, message);
  } catch (err) {
    // One attempt per day: console+Sentry already fired above, and the next
    // UTC day resets the dedupe. Alerting must never throw into a call path.
    console.warn("[cost-guard] cap-trip admin notification failed:", err);
  }
}

async function createAdminTripNotifications(
  input: CostCapTripInput,
  message: string,
): Promise<void> {
  // Lazy db import: keeps this module off the Prisma .env-autoload init path
  // (same reason cents.ts exists — see the header comment there).
  const { prisma } = await import("../db.js");
  const admins = await prisma.user.findMany({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  if (admins.length === 0) return;

  const dedupeKey =
    input.scope === "global"
      ? `cost-cap-trip:global:${tripState.dayKey}`
      : `cost-cap-trip:user:${input.userId}:${tripState.dayKey}`;
  const title = input.scope === "global" ? "LLM cost ceiling tripped" : "User LLM cost cap tripped";

  for (const admin of admins) {
    try {
      await prisma.notification.create({
        data: {
          userId: admin.id,
          type: "ops",
          dedupeKey,
          title,
          message,
        },
      });
    } catch (err) {
      // P2002 = another instance already won this (userId, dedupeKey) create.
      if ((err as { code?: string })?.code !== "P2002") throw err;
    }
  }
}

/** Test seam: reset the in-memory trip marks. */
export function __resetCostTripStateForTest(): void {
  tripState.dayKey = currentUtcDayKey();
  tripState.global = false;
  tripState.users.clear();
}
