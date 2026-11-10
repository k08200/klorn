/**
 * Email persist + firewall (M3 decomposition, extracted from email-sync.ts).
 *
 * Persists a fetched Gmail message, classifies it into one lane, mirrors it to
 * an AttentionItem, and fires a PUSH-lane interrupt. Which lanes are reachable
 * depends on TIER_V2_ENABLED (default-ON since 2026-08-18): the five live v2
 * lanes with it on, the v1 four with it off — see judge/tiers.ts. Also
 * the backfill sweep that re-judges any email left without an AttentionItem.
 * push/websocket/attention-override are lazy-imported to avoid a top-level
 * cycle. Must NOT import email-sync.ts (the sync orchestrator imports THIS).
 */

import { scheduleAgentForActionableEmail } from "../agentcore/email-action-trigger.js";
import { prisma } from "../db.js";
import { engagementKindOf } from "../learning/sender-policy.js";
import { getUserLlmCredentials } from "../llm/llm-credentials.js";
import { extractEmailAddress } from "../mail/email-address.js";
import {
  analyzePendingEmailAttachments,
  upsertEmailAttachments,
} from "../mail/email-attachments.js";
import { classifyNeedsReplyFromSignals, classifyPriority } from "../mail/email-priority.js";
import { coercePlainBody } from "../mail/email-text.js";
import type { GmailRawEmail } from "../mail/gmail-fetch.js";
import { applyLaneLabel } from "../mail/gmail-labels.js";
import { autoUnsubscribeEnabled, executeOneClickUnsubscribe } from "../mail/list-unsubscribe.js";
import { mailActionsFor } from "../mail/providers/dispatch.js";
import { reserveAutoUnsubscribe } from "../mail/unsubscribe-quota.js";
import { notifyConversationsUpdated } from "../notify/conversations-updated.js";
import { getUserNotificationLanguage } from "../notify/notification-strings.js";
import { extractAndUpsertCommitmentsFromText } from "../pim/commitment-ingestion.js";
import type { ProviderCredentials } from "../providers/index.js";
import { resolveUserEmail } from "../resolve-user-email.js";
import { captureError } from "../sentry.js";
import { upsertAttentionForEmailJudgement } from "./attention-mirror.js";
import { deliverFirewallPush, pushForFirewallEmail } from "./firewall-push.js";
import { buildJudgeContext } from "./judge-context.js";
import { recordJudgeSource } from "./judge-health.js";
import { isClearMarketing } from "./keyword-policy.js";
import { reconcileLabelCorrection } from "./label-correction.js";
import { judgeEmail, type PocJudgement, type PocTier } from "./poc-judge.js";
import { isJudgeV3PolicyEnabled, isJudgeV3ShadowEnabled } from "./v3/flags.js";
import type { V3ItemFields } from "./v3/live-item.js";
import type { V3PushPlan } from "./v3/live-judge.js";

/**
 * Normalized sender address for the `fromAddress` column — the SINGLE source of
 * truth shared with the judge sender-history query (extractEmailAddress is
 * lowercased). Empty input maps to null so the column never stores "".
 */
function normalizedFromAddress(from: string): string | null {
  return extractEmailAddress(from) || null;
}

/// The body and snippet to write on re-sync: only when asked and only when they
/// changed, so a poll that re-touches its window does not churn TOAST rows.
function refreshedBodyFields(
  existing: { body: string | null; snippet: string | null },
  email: GmailRawEmail,
  refresh: boolean,
): { body?: string | null; snippet?: string } {
  // The snippet decides, as a cheap compare: a poll that re-touches its window
  // never runs coercePlainBody on an unchanged row. Every raw-MIME row's
  // snippet differs from its decoded one (a boundary, base64, or a QP soft
  // break falls within the first 200 characters).
  if (!refresh || email.snippet === existing.snippet) return {};
  const body = coercePlainBody(email.body || null, email.htmlBody || null);
  return { body, snippet: email.snippet };
}

export async function persistGmailEmail(
  userId: string,
  email: GmailRawEmail,
  options: {
    userEmail?: string | null;
    linkedInboxAccountId?: string | null;
    /// Re-sync rewrites body and snippet when they changed. The IMAP poll sets
    /// it: rows stored as raw MIME before decoding pick up the decoded text.
    /// Gmail never sets it, so its stored body is never touched on re-sync.
    refreshBody?: boolean;
  } = {},
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
        // Backfill the normalized address on re-sync so already-persisted mail
        // gets an indexed fromAddress without a separate backfill pass.
        fromAddress: normalizedFromAddress(email.from),
        ...refreshedBodyFields(existing, email, options.refreshBody === true),
        // Same backfill contract for the List-Unsubscribe targets: rows that
        // predate the columns pick them up on the next re-sync. Guarded on
        // "the producer parsed the header at all" so a non-Gmail path that
        // never sets these can't null out stored values.
        ...(email.listUnsubscribeMailto !== undefined || email.listUnsubscribeUrl !== undefined
          ? {
              listUnsubscribeMailto: email.listUnsubscribeMailto ?? null,
              listUnsubscribeUrl: email.listUnsubscribeUrl ?? null,
              listUnsubscribeOneClick: email.listUnsubscribeOneClick ?? false,
            }
          : {}),
        // (Re)stamp provenance only when the caller holds a REAL account id:
        // the Naver poll re-touches its recent window every cycle, so pre-0b
        // rows adopt their account id without a data migration. Truthy-only on
        // purpose — every caller passes the key (primary sync passes null), so
        // an undefined-check would be dead code, and an update must never be
        // able to null out a linked row's provenance.
        ...(options.linkedInboxAccountId
          ? { linkedInboxAccountId: options.linkedInboxAccountId }
          : {}),
      },
    });
    if (email.attachments.length > 0) {
      await upsertEmailAttachments({
        userId,
        emailId: existing.id,
        attachments: email.attachments,
      });
    }
    // Label mode's other half: if the user dragged this message to a different
    // Klorn/* label in Gmail, that is the same act as moving the row in the
    // app, and it must reach the same ledger. Fire-and-forget — a sync must
    // never fail because a correction could not be recorded, and
    // reconcileLabelCorrection is a no-op when label mode is off.
    void reconcileLabelCorrection(
      userId,
      existing.id,
      email.labels,
      options.linkedInboxAccountId ?? null,
    ).catch((err) =>
      captureError(err, {
        tags: { scope: "sync-label-correction" },
        extra: { userId, emailId: existing.id },
      }),
    );

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
      linkedInboxAccountId: options.linkedInboxAccountId ?? null,
      threadId: email.threadId,
      from: email.from,
      fromAddress: normalizedFromAddress(email.from),
      to: email.to,
      cc: email.cc || null,
      subject: email.subject,
      snippet: email.snippet,
      // Some senders put raw HTML source into the text/plain part (observed
      // 2026-08-13, Paddle) — coerce at the shared persist choke point so
      // every provider path (Gmail, Outlook Graph, IMAP) stores real text.
      body: coercePlainBody(email.body || null, email.htmlBody || null),
      htmlBody: email.htmlBody || null,
      labels: email.labels,
      isRead: email.isRead,
      isStarred: email.isStarred,
      priority,
      needsReply: replyNeeded.needsReply,
      needsReplyReason: replyNeeded.reason,
      needsReplyConfidence: replyNeeded.confidence,
      receivedAt: email.receivedAt,
      listUnsubscribeMailto: email.listUnsubscribeMailto ?? null,
      listUnsubscribeUrl: email.listUnsubscribeUrl ?? null,
      listUnsubscribeOneClick: email.listUnsubscribeOneClick ?? false,
      // Only the Klorn mailbox has verdicts (step E1b); every other producer
      // leaves the column out, so it stays null.
      ...(email.authentication ? { authentication: email.authentication } : {}),
    },
  });
  if (email.attachments.length > 0) {
    await upsertEmailAttachments({
      userId,
      emailId: createdEmail.id,
      attachments: email.attachments,
    });
    analyzePendingEmailAttachments(userId, email.attachments.length).catch((err) => {
      console.warn("[FIREWALL] attachment analysis failed:", err);
      captureError(err, {
        tags: { scope: "email_attachment.analysis" },
        extra: { userId, emailId: createdEmail.id, gmailId: email.gmailId },
      });
    });
  }
  const commitmentText = [email.subject, email.body || email.snippet].filter(Boolean).join("\n\n");
  // Skip commitment mining for promotional/marketing mail: it never carries a
  // personal promise, and its "X will …" copy otherwise becomes a fake ledger
  // commitment. Automated/no-reply senders are gated inside the ingestion call
  // itself (it also runs from non-email sources, so the guard belongs there).
  if (
    commitmentText.trim() &&
    !isClearMarketing({ labels: email.labels, subject: email.subject })
  ) {
    extractAndUpsertCommitmentsFromText({
      userId,
      sourceType: "EMAIL",
      sourceId: createdEmail.id,
      threadId: email.threadId,
      text: commitmentText,
      contextTitle: email.subject,
      referenceDate: email.receivedAt,
      senderEmail: email.from,
      // First-person text in this email belongs to its author: only when the
      // user sent it to themselves does "I'll…" mean the user owes it.
      senderIsUser:
        userEmail != null && normalizedFromAddress(email.from) === userEmail.toLowerCase(),
      listUnsubscribe: email.hasListUnsubscribe === true,
    }).catch((err) => {
      captureError(err, {
        tags: { scope: "commitment.email_ingestion" },
        extra: { userId, emailId: createdEmail.id, gmailId: email.gmailId },
      });
    });
  }

  // POC firewall: classify the email into one lane and mirror it to an
  // AttentionItem so the firewall route surfaces it. Fire-and-forget
  // so sync never blocks on the LLM. If this rejects (or the process dies
  // mid-flight) the email is persisted but has no AttentionItem — the
  // backfill sweep (backfillEmailAttentionItems, run by the scheduler) is the
  // safety net that re-judges any email left without one.
  judgeAndMirrorEmail(
    userId,
    {
      id: createdEmail.id,
      gmailId: email.gmailId,
      from: email.from,
      subject: email.subject,
      snippet: email.snippet,
      body: email.body,
      labels: email.labels,
      receivedAt: email.receivedAt,
      hasListUnsubscribe: email.hasListUnsubscribe,
      linkedInboxAccountId: options.linkedInboxAccountId ?? null,
    },
    undefined,
    undefined,
    { liveRaw: email },
  )
    .then((tier) => {
      // Actionable tiers (PUSH/QUEUE) trigger an immediate agent run so the
      // user sees a draft proposal without waiting for the cron. Debounced
      // inside the trigger to bound LLM cost.
      scheduleAgentForActionableEmail(userId, tier);
      // Attention engine v3 facts shadow (JUDGE_V3_SHADOW, OFF by default):
      // after the v2 lane is decided, never changing it. Fire-and-forget. A
      // user under policy v3 already got live facts inside the judge, so the
      // shadow would only spend a second call.
      if (isJudgeV3ShadowEnabled(userId) && !isJudgeV3PolicyEnabled(userId)) {
        void startFactsShadow(userId, createdEmail.id, email, tier);
      }
      // Promotional / marketing mail (the judge's fast-path SILENT bucket) is
      // noise the user never needs to open — mark it read in Gmail so it
      // doesn't sit unread. Promotional-ONLY by product decision: QUEUE/PUSH/
      // AUTO and non-promotional SILENT keep their unread state + alerts. Gated
      // on the judge's TIER (must be SILENT) AND the SAME deterministic signal
      // the judge's fast-path uses (isClearMarketing) — without the tier gate a
      // PUSH/QUEUE email whose subject merely contains "unsubscribe" would be
      // silently marked read while ALSO firing a notification. Gmail-only by
      // construction (this is the Gmail ingest path). Fire-and-forget.
      if (tier === "SILENT" && isClearMarketing({ labels: email.labels, subject: email.subject })) {
        void markPromotionalEmailRead(userId, {
          id: createdEmail.id,
          gmailId: email.gmailId,
          linkedInboxAccountId: options.linkedInboxAccountId ?? null,
        });
        // Flag-gated automation (AUTO_UNSUBSCRIBE_ENABLED, default OFF):
        // one-click ONLY — a mailto sends as the user and a link needs a
        // browser, so neither may run unattended. Same double gate as the
        // read-marking above; fire-and-forget for the same reason.
        if (autoUnsubscribeEnabled() && email.listUnsubscribeOneClick && email.listUnsubscribeUrl) {
          void autoUnsubscribePromotional(userId, email.listUnsubscribeUrl);
        }
      }
    })
    .catch((err) => {
      // console first: captureError is a no-op without a Sentry DSN, so in
      // dev/self-host a classify+mirror failure would drop this email from the
      // firewall (the user silently misses it) with no trace. Static message +
      // the error only — the ids live in the Sentry `extra` below, never
      // interpolated into the log sink (log-injection / format-string safe).
      console.warn("[FIREWALL] classify+mirror failed (ids in Sentry extra)", err);
      captureError(err, {
        tags: { scope: "poc-judge.email_sync" },
        extra: { userId, emailId: createdEmail.id, gmailId: email.gmailId },
      });
    });

  return { emailId: createdEmail.id, isNew: true };
}

/**
 * Auto-mark a promotional/marketing email read in Gmail. Called only for mail
 * the judge silences via the marketing fast-path, so the user's inbox isn't
 * littered with unread ads. Best-effort by contract: markAsRead already
 * updates the local `isRead` mirror and returns `{ error }` (rather than
 * throwing) when Gmail is disconnected, so neither outcome can break sync or
 * classification — but we still surface a log signal on every skip/failure so
 * a silently-never-marked inbox stays diagnosable (captureError is a no-op
 * without a Sentry DSN).
 */
async function markPromotionalEmailRead(
  userId: string,
  email: { id: string; gmailId: string; linkedInboxAccountId?: string | null },
): Promise<void> {
  try {
    const actions = await mailActionsFor(userId, email.linkedInboxAccountId);
    const result = await actions.markAsRead(userId, email.gmailId, email.linkedInboxAccountId);
    // An unsupported provider (IMAP read surface doesn't exist yet) lands in
    // the same benign branch — the local isRead mirror is judge-side anyway.
    if ("error" in result && result.error) {
      // Gmail not connected / token expired — an expected, benign state (the
      // user simply hasn't linked Gmail). Log it but do NOT captureError: this
      // would fire on every promo email for every keyless user and bury real
      // signal. The unexpected failures (thrown below) are the ones worth Sentry.
      console.warn(`[FIREWALL] promo auto-read skipped (user ${userId}): ${result.error}`);
    }
  } catch (err) {
    console.warn("[FIREWALL] promo auto-read failed (ids in Sentry extra)", err);
    captureError(err, {
      tags: { scope: "firewall.promo_auto_read" },
      extra: { userId, emailId: email.id, gmailId: email.gmailId },
    });
  }
}

/**
 * The flag-gated automatic half of unsubscribe. executeOneClickUnsubscribe
 * never throws; failures are a warn only — list servers fail routinely, and
 * Sentry noise here would bury real signal (same rationale as the benign
 * branch of promo auto-read above).
 */
async function autoUnsubscribePromotional(userId: string, url: string): Promise<void> {
  // Capped per user, per target domain and fleet-wide (unsubscribe-quota.ts).
  // Fail closed: if the caps cannot be checked, nothing is sent.
  let quota: Awaited<ReturnType<typeof reserveAutoUnsubscribe>>;
  try {
    quota = await reserveAutoUnsubscribe(userId, url);
  } catch (err) {
    console.warn("[FIREWALL] auto-unsubscribe skipped: quota check failed", err);
    captureError(err, { tags: { scope: "firewall.auto_unsubscribe_quota" }, extra: { userId } });
    return;
  }
  if (!quota.ok) {
    console.warn(`[FIREWALL] auto-unsubscribe skipped: ${quota.reason}`);
    return;
  }
  const result = await executeOneClickUnsubscribe(url);
  if (!result.ok) {
    console.warn(`[FIREWALL] auto-unsubscribe failed: ${result.reason}`);
  }
}

/** A judgeable row as SELECTed from the DB (re-judge paths): the stored
 * List-Unsubscribe targets instead of the sync-time boolean. */
export interface StoredJudgeableEmailRow extends Omit<JudgeableEmailRow, "hasListUnsubscribe"> {
  listUnsubscribeMailto: string | null;
  listUnsubscribeUrl: string | null;
}

/**
 * The ONE derivation of the judge's bulk-mail boolean from the stored
 * columns — shared by the backfill sweep and the read-path heal
 * (routes/firewall.ts) so the two re-judge paths can't drift.
 */
export function toJudgeableEmailRow(row: StoredJudgeableEmailRow): JudgeableEmailRow {
  const { listUnsubscribeMailto, listUnsubscribeUrl, ...rest } = row;
  return {
    ...rest,
    // Loose != so an undefined field (a row shape that never selected the
    // columns) reads as "no header", never as a bulk-mail signal.
    hasListUnsubscribe: listUnsubscribeMailto != null || listUnsubscribeUrl != null,
  };
}

export interface JudgeableEmailRow {
  id: string;
  gmailId: string;
  from: string;
  subject: string;
  snippet: string | null;
  body?: string | null;
  labels: string[];
  receivedAt: Date;
  /** Bulk-mail marker from sync; feeds the v2 transactional detector. */
  hasListUnsubscribe?: boolean;
  /**
   * Which linked inbox this message belongs to (null = the primary account).
   * Threaded so label mode writes to the account the message actually lives
   * in — CLAUDE.md: never assume the primary account for a Gmail action.
   */
  linkedInboxAccountId?: string | null;
}

/**
 * Run the v3 facts shadow for a new mail. The module graph loads only when
 * the flag is on, so a flag-off install pays nothing. runFactsShadow never
 * throws; the catch covers a failed module load.
 */
async function startFactsShadow(
  userId: string,
  emailId: string,
  email: GmailRawEmail,
  tier: PocTier,
): Promise<void> {
  try {
    const { runFactsShadow, shadowMailFromRaw } = await import("./v3/shadow.js");
    await runFactsShadow(userId, shadowMailFromRaw(emailId, email), tier);
  } catch (err) {
    captureError(err, { tags: { scope: "judge-v3-shadow-load" }, extra: { userId, emailId } });
  }
}

/**
 * Classify one stored email into a tier and mirror it to an AttentionItem.
 * Shared by the inline sync path and the backfill sweep. buildJudgeContext
 * never throws, judgeEmail falls back to keyword features when the LLM is
 * down, and a failed v3 plan falls back to the v2 lane, so the only way this
 * produces no AttentionItem is the upsert itself throwing — in which case the
 * next backfill pass retries it.
 */
export async function judgeAndMirrorEmail(
  userId: string,
  email: JudgeableEmailRow,
  credentials?: ProviderCredentials,
  language?: string | null,
  /**
   * `rejudge`: the item already exists (the stale-hash heal). See EmailUpsertOptions.
   * `liveRaw`: the message just ingested. For a user under policy v3 it feeds the
   * live facts call; without it (re-judge, backfill) v3 reads stored facts.
   */
  options: { rejudge?: boolean; liveRaw?: GmailRawEmail } = {},
): Promise<PocTier> {
  // BYOK: route this user's classify call to their own provider key when they
  // have set one (billing.ts), so per-user load never lands on the shared env
  // key. A user without a key resolves to {quotaScope, no keys}, which
  // getProviderChain falls through to the shared env provider exactly as
  // before — so this is a no-op for keyless users. Callers that judge many
  // emails for one user (the backfill sweep) pass `credentials` so the lookup
  // happens once, not per email.
  const llmCredentials = credentials ?? (await getUserLlmCredentials(userId));
  // The reason is shown as "why this was PUSH", so it follows the user's
  // notification language — the same setting the banners use. Resolved by the
  // caller when there is one (the backfill sweep judges many emails for one
  // user and must not re-read the config per email), like `credentials`.
  const reasonLanguage = language ?? (await getUserNotificationLanguage(userId));
  const judgeContext = await buildJudgeContext(userId, {
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
      hasListUnsubscribe: email.hasListUnsubscribe,
    },
    userId,
    judgeContext,
    llmCredentials,
    undefined,
    undefined,
    reasonLanguage,
  );
  // Judge heartbeat (#742). Prod path only — the eval harness calls judgeEmail
  // directly. Observability: a throw here must never skip the upsert below.
  try {
    recordJudgeSource(judgement.source);
  } catch (err) {
    console.warn("[JUDGE-HEALTH] recordJudgeSource failed:", err);
    captureError(err, { tags: { scope: "judge-health.record" } });
  }
  // Attention engine v3 (JUDGE_V3_POLICY, for the users it covers): the lane
  // and any interrupt-budget hold are decided here, before the item is written.
  const v3 = await v3PlanFor(userId, email, judgement, llmCredentials, options);
  const written = v3?.written ?? judgement;
  const outcome = await writeJudgedItem(userId, email, written, judgeContext, options, v3);
  // A human override or an agent lane landed while the judge ran, so the write
  // was refused and their decision stands. Nothing below may run: no wake-up, no
  // push and no Gmail label for a tier that is not the one the item carries. A
  // budget slot already claimed stays spent; its bell row is hidden.
  if (outcome === "preserved") {
    if (v3?.push.kind === "deliver") {
      const { hideClaimedBellRow } = await import("./v3/push-budget-gate.js");
      await hideClaimedBellRow(userId, v3.push.notification.id);
    }
    return written.tier;
  }
  // The email just became visible on the firewall surfaces — they read
  // AttentionItem, which is written only here, post-judge. Wake every open
  // client so it refetches NOW: without this, only PUSH-tier mail produced
  // any signal after classification, and the desktop app (whose queue is
  // AttentionItem-only) waited out its 60 s poll for every other tier even
  // though the Pub/Sub → sync leg was sub-second. Best-effort by design
  // (broadcast to open sockets; no throw path).
  notifyConversationsUpdated(userId);

  // The whole point of the firewall: a PUSH tier should actually interrupt
  // you. MEETING (v2 only — v1 never emits it) notifies like PUSH: the
  // founder's 기본 모드 contract is "important mail + calendar/scheduling
  // interrupt, everything else is silent" (docs/design/tier-ontology-v2.md).
  // Best-effort: never block or fail classification on the notification.
  await ringForFirewallEmail(userId, email, written.tier, v3?.push ?? null);

  // Label mode: mirror the decided lane back into Gmail so the classification
  // is visible in whatever client the user already reads mail in. Best-effort
  // and flag-gated — applyLaneLabel never throws, and returns "skipped" when
  // the flag is off, the account is IMAP, or the tier is the retired AUTO.
  void applyLaneLabel(
    userId,
    email.gmailId,
    written.tier,
    email.linkedInboxAccountId ?? null,
  ).catch((err) =>
    captureError(err, {
      tags: { scope: "firewall-label-mode" },
      extra: { userId, emailId: email.id },
    }),
  );

  return written.tier;
}

interface V3Write {
  written: PocJudgement;
  v3?: V3ItemFields;
  push: V3PushPlan;
}

/**
 * The v3 plan for a user under the policy; null for everyone else. A plan that
 * fails (a database error) falls back to the v2 lane with no v3 columns and no
 * PUSH notification, so the mail is still written and the budget is never
 * bypassed. MEETING still rings: it is not budgeted.
 */
async function v3PlanFor(
  userId: string,
  email: JudgeableEmailRow,
  judgement: PocJudgement,
  credentials: ProviderCredentials,
  options: { rejudge?: boolean; liveRaw?: GmailRawEmail },
): Promise<V3Write | null> {
  if (!isJudgeV3PolicyEnabled(userId)) return null;
  try {
    const { judgementUnderPlan, planV3Write } = await import("./v3/live-judge.js");
    const plan = await planV3Write({
      userId,
      email,
      judgement,
      rejudge: options.rejudge === true,
      liveRaw: options.liveRaw,
      credentials,
      allowPush: true,
    });
    return { written: judgementUnderPlan(judgement, plan), v3: plan.v3, push: plan.push };
  } catch (err) {
    console.warn("[FIREWALL] v3 plan failed; writing the v2 lane (ids in Sentry extra)", err);
    captureError(err, { tags: { scope: "judge-v3-plan" }, extra: { userId, emailId: email.id } });
    const push: V3PushPlan = judgement.tier === "MEETING" ? { kind: "meeting" } : { kind: "none" };
    return { written: judgement, push };
  }
}

/**
 * Write the item. If the write throws after a budget slot was claimed, the
 * claim is released: nothing rang, and the retry (the backfill sweep) must be
 * able to claim and ring again rather than find its own bell row as a dedupe.
 */
async function writeJudgedItem(
  userId: string,
  email: JudgeableEmailRow,
  written: PocJudgement,
  judgeContext: Awaited<ReturnType<typeof buildJudgeContext>>,
  options: { rejudge?: boolean },
  v3: V3Write | null,
) {
  try {
    return await upsertAttentionForEmailJudgement(
      { userId, ...email },
      written,
      engagementKindOf(judgeContext.senderFacts),
      { rejudge: options.rejudge, v3: v3?.v3 },
    );
  } catch (err) {
    if (v3?.push.kind === "deliver") {
      const { releaseClaimedBellRow } = await import("./v3/push-budget-gate.js");
      await releaseClaimedBellRow(userId, v3.push.notification.id).catch((releaseErr) =>
        captureError(releaseErr, {
          tags: { scope: "judge-v3-release-claim" },
          extra: { userId, emailId: email.id },
        }),
      );
    }
    throw err;
  }
}

/**
 * Ring for a judged email. v2 (plan null): PUSH and MEETING through the usual
 * gates. v3: the plan already ran the gates and claimed any budget slot for a
 * PUSH, so only delivery is left; MEETING takes the usual unbudgeted path.
 */
async function ringForFirewallEmail(
  userId: string,
  email: JudgeableEmailRow,
  tier: PocTier,
  push: V3PushPlan | null,
): Promise<void> {
  try {
    if (push === null) {
      if (tier === "PUSH" || tier === "MEETING") await pushForFirewallEmail(userId, email, false);
      return;
    }
    if (push.kind === "deliver") await deliverFirewallPush(userId, email, push.notification);
    else if (push.kind === "meeting") await pushForFirewallEmail(userId, email, true);
  } catch (err) {
    captureError(err, { tags: { scope: "firewall-push" }, extra: { userId, emailId: email.id } });
  }
}

const BACKFILL_LOOKBACK_DAYS = 14;
const BACKFILL_LOOKBACK_MS = BACKFILL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
// For a user under policy v3 the inline judge can run for the live facts
// deadline plus a wait for a model slot. The sweep leaves mail that young to
// the inline judge, so the two never judge (and claim a budget slot for) the
// same mail at once.
const V3_BACKFILL_MIN_AGE_MS = 5 * 60 * 1000;
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
  const youngest = isJudgeV3PolicyEnabled(userId)
    ? { createdAt: { lte: new Date(Date.now() - V3_BACKFILL_MIN_AGE_MS) } }
    : {};
  const recent = (
    (await prisma.emailMessage.findMany({
      where: { userId, receivedAt: { gte: cutoff }, ...youngest },
      select: {
        id: true,
        gmailId: true,
        from: true,
        subject: true,
        snippet: true,
        body: true,
        labels: true,
        receivedAt: true,
        linkedInboxAccountId: true,
        listUnsubscribeMailto: true,
        listUnsubscribeUrl: true,
      },
      orderBy: { receivedAt: "desc" },
      take: BACKFILL_SCAN_LIMIT,
    })) as StoredJudgeableEmailRow[]
  ).map(toJudgeableEmailRow);
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

  // Resolve the user's BYOK credentials once for the whole sweep — a backlog
  // can be hundreds of emails for the same user, so fetching per email would
  // be a needless query per row.
  const llmCredentials = await getUserLlmCredentials(userId);
  // Resolve once for the whole sweep, like the credentials above — this loop
  // judges many emails for one user and must not re-read the config per email.
  const reasonLanguage = await getUserNotificationLanguage(userId);

  let done = 0;
  for (const email of unjudged) {
    try {
      await judgeAndMirrorEmail(userId, email, llmCredentials, reasonLanguage);
      done++;
    } catch (err) {
      // console first: captureError is silent without a Sentry DSN, and a
      // backfill that fails every email would otherwise look like a no-op.
      // Static message + error only; the id lives in the Sentry `extra`.
      console.warn("[FIREWALL] backfill judge+mirror failed (id in Sentry extra)", err);
      captureError(err, {
        tags: { scope: "email-backfill" },
        extra: { userId, emailId: email.id },
      });
    }
  }
  return done;
}
