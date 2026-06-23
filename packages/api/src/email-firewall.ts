/**
 * Email persist + firewall (M3 decomposition, extracted from email-sync.ts).
 *
 * Persists a fetched Gmail message, classifies it into a SILENT/QUEUE/PUSH/AUTO
 * tier, mirrors it to an AttentionItem, and fires a PUSH-tier interrupt. Also
 * the backfill sweep that re-judges any email left without an AttentionItem.
 * push/websocket/attention-override are lazy-imported to avoid a top-level
 * cycle. Must NOT import email-sync.ts (the sync orchestrator imports THIS).
 */

import { upsertAttentionForEmailJudgement } from "./attention-mirror.js";
import { extractAndUpsertCommitmentsFromText } from "./commitment-ingestion.js";
import { prisma } from "./db.js";
import { scheduleAgentForActionableEmail } from "./email-action-trigger.js";
import { analyzePendingEmailAttachments, upsertEmailAttachments } from "./email-attachments.js";
import { classifyNeedsReplyFromSignals, classifyPriority } from "./email-priority.js";
import type { GmailRawEmail } from "./gmail-fetch.js";
import { buildJudgeContext } from "./judge-context.js";
import { judgeEmail, type PocTier } from "./poc-judge.js";
import { resolveUserEmail } from "./resolve-user-email.js";
import { captureError } from "./sentry.js";

export async function persistGmailEmail(
  userId: string,
  email: GmailRawEmail,
  options: { userEmail?: string | null } = {},
): Promise<{ emailId: string; isNew: boolean }> {
  const existing = await prisma.emailMessage.findUnique({
    where: { userId_gmailId: { userId, gmailId: email.gmailId } },
  });

  if (existing) {
    await prisma.emailMessage.update({
      where: { id: existing.id },
      data: {
        isRead: email.isRead,
        isStarred: email.isStarred,
        labels: email.labels,
      },
    });
    if (email.attachments.length > 0) {
      await upsertEmailAttachments({
        userId,
        emailId: existing.id,
        attachments: email.attachments,
      });
    }
    return { emailId: existing.id, isNew: false };
  }

  const userEmail = options.userEmail ?? (await resolveUserEmail(userId));
  const priority = classifyPriority(email.from, email.subject, email.labels);
  const replyNeeded = classifyNeedsReplyFromSignals({
    from: email.from,
    subject: email.subject,
    labels: email.labels,
    priority,
    userEmail,
  });

  const createdEmail = await prisma.emailMessage.create({
    data: {
      userId,
      gmailId: email.gmailId,
      threadId: email.threadId,
      from: email.from,
      to: email.to,
      cc: email.cc || null,
      subject: email.subject,
      snippet: email.snippet,
      body: email.body || null,
      htmlBody: email.htmlBody || null,
      labels: email.labels,
      isRead: email.isRead,
      isStarred: email.isStarred,
      priority,
      needsReply: replyNeeded.needsReply,
      needsReplyReason: replyNeeded.reason,
      needsReplyConfidence: replyNeeded.confidence,
      receivedAt: email.receivedAt,
    },
  });
  if (email.attachments.length > 0) {
    await upsertEmailAttachments({
      userId,
      emailId: createdEmail.id,
      attachments: email.attachments,
    });
    analyzePendingEmailAttachments(userId, email.attachments.length).catch((err) => {
      captureError(err, {
        tags: { scope: "email_attachment.analysis" },
        extra: { userId, emailId: createdEmail.id, gmailId: email.gmailId },
      });
    });
  }
  const commitmentText = [email.subject, email.body || email.snippet].filter(Boolean).join("\n\n");
  if (commitmentText.trim()) {
    extractAndUpsertCommitmentsFromText({
      userId,
      sourceType: "EMAIL",
      sourceId: createdEmail.id,
      threadId: email.threadId,
      text: commitmentText,
      contextTitle: email.subject,
      referenceDate: email.receivedAt,
      senderEmail: email.from,
    }).catch((err) => {
      captureError(err, {
        tags: { scope: "commitment.email_ingestion" },
        extra: { userId, emailId: createdEmail.id, gmailId: email.gmailId },
      });
    });
  }

  // POC firewall: classify the email into SILENT/QUEUE/PUSH/AUTO and mirror
  // it to an AttentionItem so the firewall route surfaces it. Fire-and-forget
  // so sync never blocks on the LLM. If this rejects (or the process dies
  // mid-flight) the email is persisted but has no AttentionItem — the
  // backfill sweep (backfillEmailAttentionItems, run by the scheduler) is the
  // safety net that re-judges any email left without one.
  judgeAndMirrorEmail(userId, {
    id: createdEmail.id,
    gmailId: email.gmailId,
    from: email.from,
    subject: email.subject,
    snippet: email.snippet,
    labels: email.labels,
    receivedAt: email.receivedAt,
  })
    .then((tier) => {
      // Actionable tiers (PUSH/QUEUE) trigger an immediate agent run so the
      // user sees a draft proposal without waiting for the cron. Debounced
      // inside the trigger to bound LLM cost.
      scheduleAgentForActionableEmail(userId, tier);
    })
    .catch((err) => {
      captureError(err, {
        tags: { scope: "poc-judge.email_sync" },
        extra: { userId, emailId: createdEmail.id, gmailId: email.gmailId },
      });
    });

  return { emailId: createdEmail.id, isNew: true };
}

interface JudgeableEmailRow {
  id: string;
  gmailId: string;
  from: string;
  subject: string;
  snippet: string | null;
  labels: string[];
  receivedAt: Date;
}

/**
 * Classify one stored email into a tier and mirror it to an AttentionItem.
 * Shared by the inline sync path and the backfill sweep. buildJudgeContext
 * never throws and judgeEmail falls back to keyword features when the LLM is
 * down, so the only way this produces no AttentionItem is the upsert itself
 * throwing — in which case the next backfill pass retries it.
 */
export async function judgeAndMirrorEmail(
  userId: string,
  email: JudgeableEmailRow,
): Promise<PocTier> {
  const judgeContext = await buildJudgeContext(userId, {
    from: email.from,
    excludeEmailId: email.id,
  });
  const judgement = await judgeEmail(
    {
      from: email.from,
      subject: email.subject,
      snippet: email.snippet,
      labels: email.labels,
    },
    userId,
    judgeContext,
  );
  await upsertAttentionForEmailJudgement({ userId, ...email }, judgement);

  // The whole point of the firewall: a PUSH tier should actually interrupt
  // you. Until now nothing did — email pushes fired only off the separate
  // keyword `classifyPriority === URGENT` heuristic, so the smart judge could
  // (correctly) tier an email PUSH and the notification never went out. Wire
  // the judge's PUSH decision to a real push. Best-effort: never block or
  // fail classification on the notification.
  if (judgement.tier === "PUSH") {
    await pushForFirewallEmail(userId, email).catch((err) =>
      captureError(err, {
        tags: { scope: "firewall-push" },
        extra: { userId, emailId: email.id },
      }),
    );
  }
  return judgement.tier;
}

// A push for a PUSH-tier email only fires for genuinely recent mail. The
// backfill sweep re-judges emails that arrived while the dyno slept; tiering
// a days-old email in the firewall is right, but firing a stale "urgent" push
// for it is not.
const FIREWALL_PUSH_RECENCY_MS = 6 * 60 * 60 * 1000;
const PUSH_DEDUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// Shared notification title with the urgent-priority sweep
// (automation-scheduler.ts) so the two dedup against each other: whichever
// fires first writes "Urgent email" + "[gmailId]", and the other skips. An
// email that is both keyword-URGENT and judge-PUSH gets exactly one push.
const FIREWALL_PUSH_TITLE = "Urgent email";

function senderDisplayName(from: string): string {
  const angle = from.indexOf("<");
  const name = angle > 0 ? from.slice(0, angle).trim().replace(/^"|"$/g, "") : from.trim();
  return name || from;
}

/**
 * Send a push for an email the judge tiered PUSH. Recency-guarded (never push
 * backfilled old mail) and deduped (shared marker with the urgent-priority
 * sweep so an email never gets two pushes). sendPushNotification applies the
 * quiet-hours / rate-limit / Telegram gates, so we don't re-check them here.
 */
async function pushForFirewallEmail(userId: string, email: JudgeableEmailRow): Promise<void> {
  const ageMs = Date.now() - email.receivedAt.getTime();
  if (ageMs > FIREWALL_PUSH_RECENCY_MS) {
    // Suppressing a stale PUSH is intentional (dyno slept, or a late manual sync
    // / backfill surfaced old mail), but it must not be silent: this is the
    // first thing to check when a PUSH-tier email fired no alarm. push.ts logs
    // every other suppression reason; this early return is the one blind spot.
    console.log(
      `[PUSH] Firewall PUSH suppressed (stale: ${Math.round(ageMs / 3_600_000)}h old) ` +
        `for email ${email.gmailId} user ${userId}`,
    );
    return;
  }

  const already = await prisma.notification.findFirst({
    where: {
      userId,
      type: "email",
      title: FIREWALL_PUSH_TITLE,
      message: { contains: `[${email.gmailId}]` },
      createdAt: { gte: new Date(Date.now() - PUSH_DEDUP_WINDOW_MS) },
    },
    select: { id: true },
  });
  if (already) {
    console.log(
      `[PUSH] Firewall PUSH deduped (already notified within ${PUSH_DEDUP_WINDOW_MS / 86_400_000}d) ` +
        `for email ${email.gmailId} user ${userId}`,
    );
    return;
  }

  const sender = senderDisplayName(email.from);
  const body = `${sender}: ${email.subject || "(no subject)"}`.slice(0, 200);

  // Bell row carries the [gmailId] dedup marker (read back by both this path
  // and the urgent-priority sweep).
  const notification = await prisma.notification.create({
    data: {
      userId,
      type: "email",
      title: FIREWALL_PUSH_TITLE,
      message: `${body} [${email.gmailId}]`,
    },
  });

  const [{ pushNotification }, { sendPushNotification }, { findOpenEmailAttentionItemId }] =
    await Promise.all([
      import("./websocket.js"),
      import("./push.js"),
      import("./attention-override.js"),
    ]);

  pushNotification(userId, {
    id: notification.id,
    type: "email",
    title: FIREWALL_PUSH_TITLE,
    message: body,
    createdAt: notification.createdAt.toISOString(),
  });

  const attentionItemId = await findOpenEmailAttentionItemId(userId, email.id);
  await sendPushNotification(
    userId,
    {
      title: `Klorn — ${sender}`,
      body: email.subject || "(no subject)",
      url: "/inbox/firewall",
      attentionItemId: attentionItemId ?? undefined,
    },
    "email_urgent",
  );
}

const BACKFILL_LOOKBACK_DAYS = 14;
const BACKFILL_LOOKBACK_MS = BACKFILL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
const BACKFILL_SCAN_LIMIT = 200;
const BACKFILL_BATCH = 10;

/**
 * Re-judge recently-synced emails that have no AttentionItem.
 *
 * The inline judge (above) is fire-and-forget: a transient LLM/DB failure, or
 * a dyno killed mid-flight (free-tier sleep), strands the email — it shows in
 * the mail view but never appears in the firewall tiers, and can't even be
 * re-tiered (no row → no override target). This sweep is the durable safety
 * net. Bounded per call (BACKFILL_BATCH) so a large backlog (e.g. mail that
 * arrived while the instance slept) drains over a few scheduler ticks instead
 * of bursting the paid judge model. A no-op once caught up. Returns the count
 * re-judged.
 */
export async function backfillEmailAttentionItems(userId: string): Promise<number> {
  const cutoff = new Date(Date.now() - BACKFILL_LOOKBACK_MS);
  const recent = (await prisma.emailMessage.findMany({
    where: { userId, receivedAt: { gte: cutoff } },
    select: {
      id: true,
      gmailId: true,
      from: true,
      subject: true,
      snippet: true,
      labels: true,
      receivedAt: true,
    },
    orderBy: { receivedAt: "desc" },
    take: BACKFILL_SCAN_LIMIT,
  })) as JudgeableEmailRow[];
  if (recent.length === 0) return 0;

  const judged = (await prisma.attentionItem.findMany({
    where: { userId, source: "EMAIL", sourceId: { in: recent.map((e) => e.id) } },
    select: { sourceId: true },
  })) as Array<{ sourceId: string }>;
  const judgedIds = new Set(judged.map((a) => a.sourceId));

  // Oldest-first within the batch so a backlog drains in arrival order.
  const unjudged = recent
    .filter((e) => !judgedIds.has(e.id))
    .reverse()
    .slice(0, BACKFILL_BATCH);

  let done = 0;
  for (const email of unjudged) {
    try {
      await judgeAndMirrorEmail(userId, email);
      done++;
    } catch (err) {
      captureError(err, {
        tags: { scope: "email-backfill" },
        extra: { userId, emailId: email.id },
      });
    }
  }
  return done;
}
