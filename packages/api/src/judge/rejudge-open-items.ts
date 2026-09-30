/**
 * Re-judge a user's OPEN email firewall items with the CURRENT classifier — the
 * core of scripts/rejudge-open-email-items.ts (same shape as rejudge-fallback.ts).
 *
 * Why: AttentionItem.tier is frozen at judgement time and only refreshed on a
 * re-judge. After a classifier change (e.g. the automated-sender PUSH floor, the
 * routine-confirmation cap), already-classified items keep their stale tier. This
 * re-runs judgeEmail and refreshes the stored tier — WITHOUT firing notifications
 * (a re-judge must never re-push, or a cleanup would spam the user with alerts).
 *
 * Human always wins: an item carrying a human override or an MCP agent's lane is
 * neither judged nor counted as a tier change. It is counted as KEPT, in dry-run
 * and in apply mode alike, so the summary read before CONFIRM=1 matches what
 * CONFIRM=1 does. A decision that lands while the judge runs is caught by the
 * guarded re-judge write (attention-mirror EmailUpsertOptions.rejudge) and is also
 * counted as kept. Terminal decisions are preserved too: the write never
 * resurrects a DISMISSED/RESOLVED item.
 *
 * Each unprotected item costs one judge model call in BOTH dry-run and apply (the
 * preview computes the real new tier). Uses the user's BYOK key when set.
 */

import { prisma } from "../db.js";
import { engagementKindOf } from "../learning/sender-policy.js";
import { getUserLlmCredentials } from "../llm/llm-credentials.js";
import { upsertAttentionForEmailJudgement } from "./attention-mirror.js";
import { buildJudgeContext } from "./judge-context.js";
import { judgeEmail } from "./poc-judge.js";
import { normalizeTier } from "./tiers.js";

export interface RejudgeRunOptions {
  /** Write the refreshed tiers (default is a dry run that writes nothing). */
  confirm: boolean;
  /** Cap on how many OPEN items are processed. */
  limit?: number;
  log?: (line: string) => void;
}

export interface RejudgeRunSummary {
  /** Tier changes (dry-run: would change; apply: written). */
  changed: number;
  /** Items left alone: a human override or an agent lane. */
  kept: number;
  /** Items whose EmailMessage row is gone. */
  missing: number;
  /** "PUSH→QUEUE" → count. */
  transitions: ReadonlyMap<string, number>;
}

interface OpenItem {
  id: string;
  sourceId: string;
  tier: string | null;
  isManualOverride: boolean;
  agentTierSetAt: Date | null;
}

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

const EMPTY: RejudgeRunSummary = { changed: 0, kept: 0, missing: 0, transitions: new Map() };

const keptOne = (t: RejudgeRunSummary): RejudgeRunSummary => ({ ...t, kept: t.kept + 1 });
const missingOne = (t: RejudgeRunSummary): RejudgeRunSummary => ({ ...t, missing: t.missing + 1 });
const changedOne = (t: RejudgeRunSummary, key: string): RejudgeRunSummary => ({
  ...t,
  changed: t.changed + 1,
  transitions: new Map(t.transitions).set(key, (t.transitions.get(key) ?? 0) + 1),
});

const isProtected = (item: OpenItem): boolean =>
  item.isManualOverride || item.agentTierSetAt != null;

function fetchOpenItems(userId: string, limit: number | undefined): Promise<OpenItem[]> {
  return prisma.attentionItem.findMany({
    where: { userId, source: "EMAIL", status: "OPEN" },
    select: { id: true, sourceId: true, tier: true, isManualOverride: true, agentTierSetAt: true },
    orderBy: { surfacedAt: "desc" },
    ...(limit ? { take: limit } : {}),
  });
}

async function fetchEmails(
  userId: string,
  items: OpenItem[],
): Promise<Map<string, JudgeableEmailRow>> {
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
  return new Map(emails.map((e) => [e.id, e]));
}

interface RunContext {
  userId: string;
  credentials: Awaited<ReturnType<typeof getUserLlmCredentials>>;
  confirm: boolean;
  log: (line: string) => void;
}

/** Judge one unprotected item and fold its outcome into the tally. */
async function rejudgeOne(
  run: RunContext,
  item: OpenItem,
  email: JudgeableEmailRow,
  tally: RejudgeRunSummary,
): Promise<RejudgeRunSummary> {
  const ctx = await buildJudgeContext(run.userId, {
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
    run.userId,
    ctx,
    run.credentials,
  );

  if (run.confirm) {
    // NO push: a re-judge refreshes the tier through the guarded re-judge write and
    // must never re-notify. (judgeAndMirrorEmail's push path is intentionally NOT
    // called here.) "preserved" means a decision landed while the judge ran.
    const outcome = await upsertAttentionForEmailJudgement(
      { userId: run.userId, ...email },
      judgement,
      engagementKindOf(ctx.senderFacts),
      { rejudge: true },
    );
    if (outcome === "preserved") return keptOne(tally);
  }

  const oldTier = normalizeTier(item.tier);
  if (oldTier === judgement.tier) return tally;
  const key = `${oldTier}→${judgement.tier}`;
  run.log(`  ${key}  ${email.from} :: ${email.subject.slice(0, 60)}`);
  return changedOne(tally, key);
}

export async function rejudgeOpenEmailItems(
  userId: string,
  options: RejudgeRunOptions,
): Promise<RejudgeRunSummary> {
  const log = options.log ?? (() => {});
  const items = await fetchOpenItems(userId, options.limit);
  if (items.length === 0) {
    log(`User ${userId}: no OPEN email items. Nothing to re-judge.`);
    return EMPTY;
  }
  const emails = await fetchEmails(userId, items);
  const run: RunContext = {
    userId,
    credentials: await getUserLlmCredentials(userId),
    confirm: options.confirm,
    log,
  };
  log(
    `\nUser ${userId}: re-judging ${items.length} OPEN email item(s)${options.confirm ? " [APPLY]" : " [DRY RUN]"}\n`,
  );

  let tally = EMPTY;
  for (const item of items) {
    const email = emails.get(item.sourceId);
    if (!email) tally = missingOne(tally);
    else if (isProtected(item)) tally = keptOne(tally);
    else tally = await rejudgeOne(run, item, email, tally);
  }
  return tally;
}
