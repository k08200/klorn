/**
 * Rejudge keyword-fallback decisions left behind by a provider outage.
 *
 * Why this exists: when every provider is down (e.g. the 2026-07 RPM
 * starvation, root-caused in #843/#844), judgeEmail degrades to the keyword
 * fallback and the result is PERMANENT — the backfill sweep only judges
 * emails with no AttentionItem, so a fallback-judged email is never looked at
 * again. Measured on the dogfood account 2026-07-16: 33 of 288 ledger rows
 * (11.5%) were keyword-fallback, all from the starvation window.
 *
 * Targets ONLY rows that are safe to re-judge (the freeze policy stands):
 *   - DecisionLabel.decidedBy = "keyword-fallback"  (the degraded judgments)
 *   - DecisionLabel.outcome IS NULL                 (no human confirm/override)
 *   - AttentionItem.status = OPEN, isManualOverride = false
 *
 * DRY RUN by default: judges each target through the production context path
 * (buildJudgeContext → judgeEmail) and prints old→new without writing.
 * Writes only with CONFIRM=1:
 *   - AttentionItem.tier/tierReason (never isManualOverride), and
 *   - the decision ledger via recordEmailDecision, whose upsert semantics
 *     already encode the contract (refresh while outcome is null, frozen
 *     once the user has acted) — this script adds no second write path.
 * A re-judge that itself comes back "keyword-fallback" is skipped: never
 * overwrite a fallback with another fallback.
 *
 * Usage (packages/api):
 *   npx tsx scripts/rejudge-fallback.ts --user=<account email>            # dry run
 *   CONFIRM=1 npx tsx scripts/rejudge-fallback.ts --user=<account email>  # apply
 *   Optional: --limit=<n>  --delay=<ms, default 500>
 * Run with JUDGE_INCLUDE_BODY=true to match prod judging.
 */

import { prisma } from "../src/db.js";
import { buildJudgeContext } from "../src/judge/judge-context.js";
import { recordEmailDecision } from "../src/judge/decision-label.js";
import { judgeEmail } from "../src/judge/poc-judge.js";
import { engagementKindOf } from "../src/learning/sender-policy.js";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

const userEmail = arg("user");
if (!userEmail) throw new Error("--user=<account email> is required");
const limit = Number(arg("limit") ?? Number.POSITIVE_INFINITY);
const delayMs = Number(arg("delay") ?? 500);
const APPLY = process.env.CONFIRM === "1";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<number> {
  const user = await prisma.user.findUnique({
    where: { email: userEmail },
    select: { id: true },
  });
  if (!user) throw new Error(`no user found for email=${userEmail}`);

  const fallbackRows = await prisma.decisionLabel.findMany({
    where: { userId: user.id, source: "EMAIL", decidedBy: "keyword-fallback", outcome: null },
    select: { sourceId: true, shownTier: true },
    orderBy: { judgedAt: "asc" },
  });
  const items = await prisma.attentionItem.findMany({
    where: {
      userId: user.id,
      source: "EMAIL",
      sourceId: { in: fallbackRows.map((r) => r.sourceId) },
      status: "OPEN",
      isManualOverride: false,
    },
    select: { id: true, sourceId: true, tier: true },
  });
  const itemBySource = new Map(items.map((i) => [i.sourceId, i]));
  const targets = fallbackRows.filter((r) => itemBySource.has(r.sourceId)).slice(0, limit);
  console.log(
    `${targets.length} fallback-judged, human-untouched, OPEN item(s) for ${userEmail} — ${APPLY ? "APPLYING" : "DRY RUN (set CONFIRM=1 to write)"}`,
  );

  let changed = 0;
  let unchanged = 0;
  let skippedFallback = 0;
  for (const row of targets) {
    const item = itemBySource.get(row.sourceId);
    if (!item) continue;
    const email = await prisma.emailMessage.findUnique({
      where: { id: row.sourceId },
      select: { id: true, from: true, subject: true, snippet: true, body: true, labels: true },
    });
    if (!email) {
      console.log(`  SKIP (email row gone): ${row.sourceId}`);
      continue;
    }
    const context = await buildJudgeContext(user.id, {
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
        labels: email.labels,
      },
      user.id,
      context,
    );
    if (judgement.source === "keyword-fallback") {
      skippedFallback++;
      console.log(`  SKIP (provider still degraded): ${email.subject.slice(0, 50)}`);
      await sleep(delayMs);
      continue;
    }
    const delta = item.tier === judgement.tier ? "=" : `${item.tier}→${judgement.tier}`;
    console.log(
      `  [${delta}] (${judgement.source}) ${email.subject.slice(0, 55)} :: ${judgement.reason.slice(0, 50)}`,
    );
    if (item.tier === judgement.tier) unchanged++;
    else changed++;

    if (APPLY) {
      // Re-check the human-untouched guards at write time — first action wins.
      await prisma.attentionItem.updateMany({
        where: { id: item.id, status: "OPEN", isManualOverride: false },
        data: { tier: judgement.tier, tierReason: judgement.reason },
      });
      if (judgement.features) {
        await recordEmailDecision({
          userId: user.id,
          sourceId: email.id,
          shownTier: judgement.tier,
          features: judgement.features,
          sender: email.from,
          decidedBy: judgement.source ?? null,
          engagementKind: engagementKindOf(context.senderFacts ?? null),
        });
      }
    }
    await sleep(delayMs);
  }

  console.log(
    `\nsummary: ${changed} tier change(s), ${unchanged} unchanged, ${skippedFallback} skipped (still-fallback)${APPLY ? " — WRITTEN" : " — dry run, nothing written"}`,
  );
  return 0;
}

main()
  .then((code) => prisma.$disconnect().then(() => process.exit(code)))
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
