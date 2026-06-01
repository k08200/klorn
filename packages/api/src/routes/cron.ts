/**
 * External cron entrypoint.
 *
 * Render Free tier dynos sleep after 15 min of inactivity, which means the
 * in-process automation-scheduler (briefing, calendar sync, etc.) never
 * fires on the schedule the founder configured — the dyno is asleep at
 * 6 AM KST and the briefing tick is dropped.
 *
 * Founder dogfood evidence 2026-05-31 → 06-01: the briefing landed once
 * across multiple days instead of every morning. The same pattern is in
 * `project_eve_dogfood_pain` from 2026-04-20 ("아침 브리핑 X").
 *
 * The honest fix is moving to a paid Render plan so the dyno stays warm.
 * The free-tier-compatible fix is to let an external cron service ping
 * this endpoint; the HTTP request itself wakes the dyno, after which the
 * normal briefing logic runs unchanged.
 *
 * Auth: shared secret in `X-Cron-Secret` header, compared timing-safely
 * against `BRIEFING_CRON_SECRET`. If the env is unset or shorter than 16
 * chars (a misconfigured deploy), every request returns 503 — we'd
 * rather fail closed than ship an unauthenticated public endpoint.
 */

import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { hasBriefingBeenSentToday, isBriefingDue } from "../automation-scheduler.js";
import { createDailyBriefingDelivery } from "../briefing.js";
import { prisma } from "../db.js";
import { captureError } from "../sentry.js";
import { normalizeTimeZone } from "../time-zone.js";

interface BriefingTickResult {
  ok: boolean;
  triggered: number;
  skipped: number;
  failed: number;
  reason?: string;
}

function isAuthorizedCronCall(headerValue: unknown, expected: string): boolean {
  if (typeof headerValue !== "string") return false;
  // Length-mismatch shortcut so timingSafeEqual doesn't throw on bad input.
  if (headerValue.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(headerValue), Buffer.from(expected));
  } catch {
    return false;
  }
}

export async function cronRoutes(app: FastifyInstance) {
  // POST /api/cron/briefing-tick
  //
  // External scheduler entrypoint. Call this every 10–15 min in production.
  // Internally we check each user's briefingTime window and only trigger
  // the briefing once per local day per user (dedup via
  // hasBriefingBeenSentToday). Safe to call any number of times.
  app.post("/briefing-tick", async (request, reply): Promise<BriefingTickResult> => {
    const expected = process.env.BRIEFING_CRON_SECRET ?? "";
    if (expected.length < 16) {
      // Misconfigured deploy. Fail closed — never let an unauthenticated
      // caller trigger briefings, even if the env is missing entirely.
      reply.code(503);
      return {
        ok: false,
        triggered: 0,
        skipped: 0,
        failed: 0,
        reason: "BRIEFING_CRON_SECRET not configured (set in Render env, ≥16 chars)",
      };
    }

    const provided = request.headers["x-cron-secret"];
    if (!isAuthorizedCronCall(provided, expected)) {
      reply.code(401);
      return { ok: false, triggered: 0, skipped: 0, failed: 0, reason: "unauthorized" };
    }

    const configs = await prisma.automationConfig.findMany({
      where: { dailyBriefing: true },
      select: { userId: true, briefingTime: true, timezone: true },
    });

    let triggered = 0;
    let skipped = 0;
    let failed = 0;

    for (const config of configs) {
      const timeZone = normalizeTimeZone(
        (config as unknown as { timezone?: string | null }).timezone,
      );

      if (!isBriefingDue(config.briefingTime, timeZone)) {
        skipped += 1;
        continue;
      }
      try {
        if (await hasBriefingBeenSentToday(config.userId, timeZone)) {
          skipped += 1;
          continue;
        }
        await createDailyBriefingDelivery(config.userId);
        triggered += 1;
      } catch (err) {
        // DailyCostCapExceededError is expected back-pressure — count as
        // skipped, not failed, so the cron caller doesn't retry/alert on it.
        const errName = err instanceof Error ? err.name : "";
        if (errName === "DailyCostCapExceededError") {
          skipped += 1;
          continue;
        }
        failed += 1;
        captureError(err, {
          tags: { scope: "cron.briefing-tick" },
          extra: { userId: config.userId },
        });
      }
    }

    return { ok: true, triggered, skipped, failed };
  });
}
