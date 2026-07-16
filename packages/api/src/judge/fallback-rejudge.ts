/**
 * Fallback-rejudge — self-healing for provider-outage residue.
 *
 * When every LLM provider is unavailable, judgeEmail degrades to the keyword
 * fallback and the resulting tier is PERMANENT by default: the backfill sweep
 * (email-firewall.ts) only judges emails with NO AttentionItem, so a
 * fallback-judged email is never revisited. Measured 2026-07-16 after the RPM
 * starvation (#843/#844): 33 of 288 dogfood ledger rows — including five
 * genuinely urgent mails buried in QUEUE — plus 25 rows on a real user's
 * account.
 *
 * `rejudgeFallbackItems` is the core repair: it re-runs the PRODUCTION judge
 * path (buildJudgeContext → judgeEmail) over eligible rows and, when applying,
 * rides only the sanctioned writes — AttentionItem tier/tierReason with the
 * human-untouched guards re-checked in the WHERE, and the decision ledger via
 * recordEmailDecision (whose upsert contract is already "refresh while
 * outcome is null, frozen once the user acted"). It never touches
 * isManualOverride and never sends notifications — this is a correction of an
 * already-shown tier, not new mail.
 *
 * `sweepFallbackRejudge` is the scheduler entry: flag-gated
 * (FALLBACK_REJUDGE_SWEEP, default OFF), bounded per tick, and it ABORTS the
 * moment a re-judge itself returns keyword-fallback (provider still degraded
 * — retry next tick instead of burning the batch on more fallbacks).
 * scripts/rejudge-fallback.ts is the manual CLI over the same core.
 */

import { FALLBACK_REJUDGE_SWEEP } from "../config.js";
import { prisma } from "../db.js";
import { captureError } from "../sentry.js";
import { recordEmailDecision } from "./decision-label.js";
import { buildJudgeContext } from "./judge-context.js";
import { judgeEmail } from "./poc-judge.js";

/** How far back a fallback row is still worth repairing. */
const REJUDGE_LOOKBACK_DAYS = 14;
/** Per-sweep bound so a large residue drains over ticks, not in one burst. */
const SWEEP_BATCH = 5;

export interface RejudgeSummary {
  changed: number;
  unchanged: number;
  /** 1 when the run aborted on a still-degraded provider, else 0. */
  skippedFallback: number;
}

export interface RejudgeOptions {
  /** Write the repaired tiers (default false = dry run). */
  apply?: boolean;
  /** Max rows to process this run. */
  limit?: number;
  /** Pause between judge calls, RPM-friendliness. */
  delayMs?: number;
  /** Override the repair window (manual CLI runs on older residue). */
  lookbackDays?: number;
  /** Per-row report hook (the CLI prints from this). */
  onRow?: (line: string) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Re-judge the user's eligible keyword-fallback decisions. Eligible =
 * decidedBy "keyword-fallback", outcome still null (no human confirm or
 * override), AttentionItem still OPEN and never manually moved.
 */
export async function rejudgeFallbackItems(
  userId: string,
  options: RejudgeOptions = {},
): Promise<RejudgeSummary> {
  const apply = options.apply ?? false;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const delayMs = options.delayMs ?? 500;
  const onRow = options.onRow ?? (() => {});
  const summary: RejudgeSummary = { changed: 0, unchanged: 0, skippedFallback: 0 };

  const cutoff = new Date(
    Date.now() - (options.lookbackDays ?? REJUDGE_LOOKBACK_DAYS) * 24 * 60 * 60 * 1000,
  );
  const fallbackRows = (await prisma.decisionLabel.findMany({
    where: {
      userId,
      source: "EMAIL",
      decidedBy: "keyword-fallback",
      outcome: null,
      judgedAt: { gte: cutoff },
    },
    select: { sourceId: true },
    orderBy: { judgedAt: "asc" },
  })) as Array<{ sourceId: string }>;
  if (fallbackRows.length === 0) return summary;

  const items = (await prisma.attentionItem.findMany({
    where: {
      userId,
      source: "EMAIL",
      sourceId: { in: fallbackRows.map((r) => r.sourceId) },
      status: "OPEN",
      isManualOverride: false,
    },
    select: { id: true, sourceId: true, tier: true },
  })) as Array<{ id: string; sourceId: string; tier: string | null }>;
  const itemBySource = new Map(items.map((i) => [i.sourceId, i]));
  const targets = fallbackRows.filter((r) => itemBySource.has(r.sourceId)).slice(0, limit);

  for (const row of targets) {
    const item = itemBySource.get(row.sourceId);
    if (!item) continue;
    try {
      const email = await prisma.emailMessage.findUnique({
        where: { id: row.sourceId },
        select: { id: true, from: true, subject: true, snippet: true, body: true, labels: true },
      });
      if (!email) continue;

      const context = await buildJudgeContext(userId, {
        from: email.from,
        subject: email.subject,
        excludeEmailId: email.id,
        excludeOwnCorrection: true,
      });
      const judgement = await judgeEmail(
        {
          id: email.id,
          from: email.from,
          subject: email.subject,
          snippet: email.snippet,
          body: email.body,
          labels: email.labels ?? [],
        },
        userId,
        context,
      );

      if (judgement.source === "keyword-fallback") {
        // Provider still degraded — repairing a fallback with a fallback is
        // pointless. Abort; the next run retries from the same rows.
        summary.skippedFallback = 1;
        onRow(`SKIP (provider still degraded): ${email.subject.slice(0, 50)}`);
        return summary;
      }

      const delta = item.tier === judgement.tier ? "=" : `${item.tier}→${judgement.tier}`;
      onRow(
        `[${delta}] (${judgement.source}) ${email.subject.slice(0, 55)} :: ${judgement.reason.slice(0, 50)}`,
      );
      if (item.tier === judgement.tier) summary.unchanged++;
      else summary.changed++;

      if (apply) {
        // Guards re-checked in the WHERE — the first human action wins even
        // if it landed between the read above and this write.
        await prisma.attentionItem.updateMany({
          where: { id: item.id, status: "OPEN", isManualOverride: false },
          data: { tier: judgement.tier, tierReason: judgement.reason },
        });
        if (judgement.features) {
          await recordEmailDecision({
            userId,
            sourceId: email.id,
            shownTier: judgement.tier,
            features: judgement.features,
            sender: email.from,
            decidedBy: judgement.source ?? null,
          });
        }
      }
    } catch (err) {
      console.warn("[FALLBACK-REJUDGE] row failed (id in Sentry extra)", err);
      captureError(err, {
        tags: { scope: "fallback-rejudge" },
        extra: { userId, sourceId: row.sourceId },
      });
    }
    if (delayMs > 0) await sleep(delayMs);
  }
  return summary;
}

/**
 * Scheduler entry: bounded, flag-gated self-heal pass for one user. Returns
 * the number of tiers repaired this tick (0 while the flag is off).
 */
export async function sweepFallbackRejudge(userId: string): Promise<number> {
  if (!FALLBACK_REJUDGE_SWEEP) return 0;
  const summary = await rejudgeFallbackItems(userId, {
    apply: true,
    limit: SWEEP_BATCH,
    delayMs: 1000,
  });
  return summary.changed;
}
