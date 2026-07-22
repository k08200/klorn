import { prisma } from "./db.js";

/**
 * Phase 1 retention instrumentation — first-party product analytics.
 *
 * Kept entirely in our own Postgres (no PostHog / external tracker), so it
 * never touches the Privacy Manifest, the Limited Use statement, or the CASA
 * posture. We store coarse event names + a tiny optional `meta` object — never
 * message content. Ingest is allowlisted (ANALYTICS_EVENTS) so a client can't
 * write arbitrary event names.
 *
 * The metrics answer the one question the product had no number for: does
 * anyone keep coming back (retention), and where do they die (notifications
 * muted, PUSH ignored).
 */

export const ANALYTICS_EVENTS = [
  "app_open", // client fires once per app session → DAU/WAU/MAU + retention
  "queue_action", // user acted on a decision card (approve / edit / hold / handle)
  "notif_muted", // user muted / disabled notifications — the death signal
  "push_opened", // app opened from a push notification
  "push_sent", // server-side: a push was delivered (denominator for open-rate)
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number];

export function isAnalyticsEvent(name: unknown): name is AnalyticsEventName {
  return typeof name === "string" && (ANALYTICS_EVENTS as readonly string[]).includes(name);
}

/**
 * Record one event. Fire-and-forget: analytics must never break or slow the
 * request that triggered it, so failures are swallowed (logged once). Callers
 * can `void recordEvent(...)` without awaiting.
 */
export async function recordEvent(
  userId: string | null,
  event: AnalyticsEventName,
  meta?: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.analyticsEvent.create({
      data: { userId: userId ?? null, event, meta: meta ? (meta as object) : undefined },
    });
  } catch (err) {
    // Never propagate — a missing analytics row is not worth a failed request.
    console.warn("[ANALYTICS] recordEvent failed:", (err as Error)?.message);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionMetrics {
  generatedAt: string;
  users: { total: number; new7d: number; new30d: number };
  active: { dau: number; wau: number; mau: number };
  // Fraction (0..1) of users old enough for the window who returned on/after day N.
  retention: { d1: number | null; d7: number | null; d14: number | null };
  engagement: { queueActionsPerDay7d: number; pushOpenRate: number | null; muteRate: number };
  totals: Record<string, number>;
}

/**
 * Pure retention fold — the metric math with no DB, extracted so the cohort
 * logic (the tricky part) is unit-testable with synthetic data. `getRetention
 * Metrics` fetches the rows and calls this.
 */
export function foldRetention(input: {
  now: number;
  users: { id: string; createdAt: Date }[];
  opens: { userId: string | null; createdAt: Date }[]; // app_open events
  totals: Record<string, number>;
  queueActions7d: number;
  mutedUserCount: number;
}): RetentionMetrics {
  const { now, users, opens, totals, queueActions7d, mutedUserCount } = input;

  const opensByUser = new Map<string, number[]>();
  for (const o of opens) {
    if (!o.userId) continue;
    const t = o.createdAt.getTime();
    const arr = opensByUser.get(o.userId);
    if (arr) arr.push(t);
    else opensByUser.set(o.userId, [t]);
  }

  // Active: distinct users with an app_open inside the window.
  const activeWithin = (windowMs: number): number => {
    const cutoff = now - windowMs;
    let n = 0;
    for (const ts of opensByUser.values()) if (ts.some((t) => t >= cutoff)) n++;
    return n;
  };

  // Retention: of users whose account is >= N days old, the fraction with an
  // app_open dated >= createdAt + N days (came back after day N).
  const retentionAt = (n: number): number | null => {
    const thresholdMs = n * DAY_MS;
    let denom = 0;
    let num = 0;
    for (const u of users) {
      const created = u.createdAt.getTime();
      if (now - created < thresholdMs) continue; // not old enough to judge yet
      denom++;
      const returnAfter = created + thresholdMs;
      const ts = opensByUser.get(u.id);
      if (ts?.some((t) => t >= returnAfter)) num++;
    }
    return denom === 0 ? null : num / denom;
  };

  const newWithin = (windowMs: number) =>
    users.filter((u) => now - u.createdAt.getTime() < windowMs).length;

  const pushSent = totals.push_sent ?? 0;
  const pushOpened = totals.push_opened ?? 0;

  return {
    generatedAt: new Date(now).toISOString(),
    users: { total: users.length, new7d: newWithin(7 * DAY_MS), new30d: newWithin(30 * DAY_MS) },
    active: {
      dau: activeWithin(DAY_MS),
      wau: activeWithin(7 * DAY_MS),
      mau: activeWithin(30 * DAY_MS),
    },
    retention: { d1: retentionAt(1), d7: retentionAt(7), d14: retentionAt(14) },
    engagement: {
      queueActionsPerDay7d: Math.round((queueActions7d / 7) * 10) / 10,
      pushOpenRate: pushSent === 0 ? null : pushOpened / pushSent,
      muteRate: users.length === 0 ? 0 : mutedUserCount / users.length,
    },
    totals,
  };
}

/**
 * Compute the retention dashboard. Fetch-and-fold: at Phase-1 scale (tens of
 * users) the JS fold is correct and readable; if the base ever makes this slow,
 * move the cohort math to `$queryRaw` — the output shape stays the same.
 */
export async function getRetentionMetrics(): Promise<RetentionMetrics> {
  const now = Date.now();

  const [users, opens, eventCounts, queueActions7d, mutedUsers] = await Promise.all([
    prisma.user.findMany({ select: { id: true, createdAt: true } }),
    prisma.analyticsEvent.findMany({
      where: { event: "app_open", userId: { not: null } },
      select: { userId: true, createdAt: true },
    }),
    prisma.analyticsEvent.groupBy({ by: ["event"], _count: { _all: true } }),
    prisma.analyticsEvent.count({
      where: { event: "queue_action", createdAt: { gte: new Date(now - 7 * DAY_MS) } },
    }),
    prisma.analyticsEvent.findMany({
      where: { event: "notif_muted", userId: { not: null } },
      select: { userId: true },
      distinct: ["userId"],
    }),
  ]);

  const totals: Record<string, number> = {};
  for (const row of eventCounts) totals[row.event] = row._count._all;

  return foldRetention({
    now,
    users,
    opens,
    totals,
    queueActions7d,
    mutedUserCount: mutedUsers.length,
  });
}
