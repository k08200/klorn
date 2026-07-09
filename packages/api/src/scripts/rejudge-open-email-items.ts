/**
 * Re-judge a user's OPEN email firewall items with the CURRENT classifier.
 *
 * Why: AttentionItem.tier is frozen at judgement time and only refreshed on a
 * re-judge. After a classifier change (e.g. the automated-sender PUSH floor,
 * the routine-confirmation cap), already-classified items keep their stale
 * tier. This re-runs judgeEmail on every OPEN EMAIL item and refreshes the
 * stored tier — WITHOUT firing notifications (a re-judge must never re-push,
 * or a cleanup would spam the user with dozens of alerts).
 *
 * It preserves the user's terminal decisions: upsertAttentionForEmailJudgement
 * takes the `update` branch for existing rows and never resurrects a
 * DISMISSED/RESOLVED item.
 *
 * Usage:
 *   DRY-RUN (default):  pnpm tsx src/scripts/rejudge-open-email-items.ts <userId | email>
 *   APPLY:              CONFIRM=1 pnpm tsx src/scripts/rejudge-open-email-items.ts <userId | email>
 *   Optional: LIMIT=50 to cap how many items are processed (default: all OPEN).
 *
 * Each item still costs one judge model call in BOTH dry-run and apply (the
 * preview computes the real new tier). Uses the user's BYOK key when set.
 */

import { upsertAttentionForEmailJudgement } from "../attention-mirror.js";
import { prisma } from "../db.js";
import { buildJudgeContext } from "../judge-context.js";
import { getUserLlmCredentials } from "../llm-credentials.js";
import { judgeEmail } from "../poc-judge.js";
import { engagementKindOf } from "../sender-policy.js";
import { normalizeTier } from "../tiers.js";

interface JudgeableEmailRow {
  id: string;
  gmailId: string;
  from: string;
  subject: string;
  snippet: string | null;
  body?: string | null;
  labels: string[];
  receivedAt: Date;
}

async function resolveUserId(arg: string): Promise<string | null> {
  if (arg.includes("@")) {
    const user = await prisma.user.findUnique({ where: { email: arg }, select: { id: true } });
    return user?.id ?? null;
  }
  return arg;
}

async function main() {
  const arg = process.argv[2];
  const confirm = process.env.CONFIRM === "1";
  const limit = process.env.LIMIT ? Number.parseInt(process.env.LIMIT, 10) : undefined;
  if (!arg) {
    console.error(
      "Usage: rejudge-open-email-items.ts <userId | email>  (set CONFIRM=1 to apply, LIMIT=N to cap)",
    );
    process.exit(1);
  }

  const userId = await resolveUserId(arg);
  if (!userId) {
    console.error(`No user found for "${arg}".`);
    process.exit(1);
  }

  const items = await prisma.attentionItem.findMany({
    where: { userId, source: "EMAIL", status: "OPEN" },
    select: { id: true, sourceId: true, tier: true },
    orderBy: { surfacedAt: "desc" },
    ...(limit ? { take: limit } : {}),
  });
  if (items.length === 0) {
    console.log(`User ${userId}: no OPEN email items. Nothing to re-judge.`);
    return;
  }

  const emails = (await prisma.emailMessage.findMany({
    where: { userId, id: { in: items.map((i) => i.sourceId) } },
    select: {
      id: true,
      gmailId: true,
      from: true,
      subject: true,
      snippet: true,
      body: true,
      labels: true,
      receivedAt: true,
    },
  })) as JudgeableEmailRow[];
  const emailById = new Map(emails.map((e) => [e.id, e]));

  const credentials = await getUserLlmCredentials(userId);
  console.log(
    `\nUser ${userId}: re-judging ${items.length} OPEN email item(s)${confirm ? " [APPLY]" : " [DRY RUN]"}\n`,
  );

  let changed = 0;
  let missing = 0;
  const transitions = new Map<string, number>(); // "PUSH→QUEUE" → count

  for (const item of items) {
    const email = emailById.get(item.sourceId);
    if (!email) {
      missing++;
      continue;
    }

    const ctx = await buildJudgeContext(userId, {
      from: email.from,
      subject: email.subject,
      excludeEmailId: email.id,
    });
    const judgement = await judgeEmail(
      {
        from: email.from,
        subject: email.subject,
        snippet: email.snippet,
        body: email.body,
        labels: email.labels,
      },
      userId,
      ctx,
      credentials,
    );

    const oldTier = normalizeTier(item.tier);
    const newTier = judgement.tier;
    if (oldTier !== newTier) {
      changed++;
      const key = `${oldTier}→${newTier}`;
      transitions.set(key, (transitions.get(key) ?? 0) + 1);
      console.log(`  ${key}  ${email.from} :: ${email.subject.slice(0, 60)}`);
    }

    if (confirm) {
      // NO push: re-judge refreshes the tier via the upsert `update` branch and
      // must never re-notify. (judgeAndMirrorEmail's push path is intentionally
      // NOT called here.)
      await upsertAttentionForEmailJudgement(
        { userId, ...email },
        judgement,
        engagementKindOf(ctx.senderFacts),
      );
    }
  }

  console.log(
    `\nSummary: ${changed} tier change(s)${missing ? `, ${missing} item(s) with no EmailMessage (skipped)` : ""}.`,
  );
  for (const [key, count] of [...transitions.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key}: ${count}`);
  }
  if (!confirm) {
    console.log(
      "\nDRY RUN — re-run with CONFIRM=1 to write the refreshed tiers (no notifications are sent).",
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
