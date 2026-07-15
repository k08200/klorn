/**
 * Web Push — Send browser push notifications
 *
 * Uses the Web Push protocol to deliver notifications to subscribed browsers.
 * Requires VAPID keys (generate with: npx web-push generate-vapid-keys)
 *
 * Environment variables:
 * - VAPID_PUBLIC_KEY
 * - VAPID_PRIVATE_KEY
 * - VAPID_EMAIL (mailto: contact email)
 */

import crypto from "node:crypto";
import webPush from "web-push";
import { prisma } from "../db.js";
import { Semaphore } from "../semaphore.js";
import { mintTierOverrideToken } from "../tier-override-token.js";
import { isSafePushEndpoint } from "./is-safe-push-endpoint.js";
import { notificationSuppressionReason } from "./notification-policy.js";
import { evaluateNotificationGate, type NotifCategory } from "./notification-prefs.js";
import { sendApnsPush } from "./push-apns.js";
import {
  createPushDeliveryAttempt,
  createSkippedPushDelivery,
  markPushAccepted,
  markPushFailed,
} from "./push-delivery.js";
import { sendDevicePush } from "./push-device.js";
import { isAllowedPushOrigin } from "./push-origin-allowlist.js";
import { recordPushAttempt } from "./push-rate-limit.js";
import { sendTelegramForPush } from "./telegram-notify.js";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_EMAIL = process.env.VAPID_EMAIL || "mailto:hello@klorn.ai";
const PUSH_RECEIPT_BASE_URL =
  process.env.PUSH_RECEIPT_BASE_URL || process.env.RENDER_EXTERNAL_URL || "";
const AGENT_PROPOSAL_PUSH_COOLDOWN_HOURS = 6;

// In-process retry with exponential backoff for transient FCM/WPS failures.
// We do NOT retry permanent failures (410 gone, 404 not found) — those mean
// the subscription is dead and gets cleaned up. We retry on 5xx, 429, and
// network errors, which empirically account for the bulk of "user said
// they didn't get the push" reports during dogfood (see memory:
// project_eve_dogfood_pain).
const PUSH_RETRY_DELAYS_MS = [3_000, 9_000]; // total ≤12s — bounded so the
// caller's tick doesn't stall.

// Fan-out concurrency: how many of a user's subscriptions we deliver to in
// parallel. Bounded so a user with many subscriptions during an upstream blip
// no longer serializes to N×(retry budget); one subscription's `await sleep`
// retry no longer blocks the others in the fire-and-forget judge path.
const PUSH_FANOUT_CONCURRENCY = 6;

export function shouldRetryPushError(statusCode: number | undefined): boolean {
  if (statusCode === undefined) return true; // network / no response
  if (statusCode >= 500 && statusCode < 600) return true;
  if (statusCode === 429) return true;
  return false;
}

// Budgeted-retry eviction threshold: after this many CONSECUTIVE ambiguous
// (non-410/404) delivery failures across pushes, a subscription is treated as
// dead and deleted, so it stops consuming the per-send retry budget every tick.
export const MAX_CONSECUTIVE_PUSH_FAILURES = 10;

export type PushFailureAction =
  | { kind: "delete"; reason: "expired" | "evicted" }
  | { kind: "increment"; failureCount: number };

/**
 * Decide what to do with a subscription after a failed delivery. A 410/404 is
 * definitively gone → delete. Otherwise count the consecutive failure; once it
 * reaches MAX_CONSECUTIVE_PUSH_FAILURES the endpoint has failed every push for
 * too long → evict it. A successful send resets the count (caller's job).
 */
export function decidePushFailureAction(
  currentFailureCount: number,
  statusCode: number | undefined,
): PushFailureAction {
  if (statusCode === 410 || statusCode === 404) {
    return { kind: "delete", reason: "expired" };
  }
  const next = currentFailureCount + 1;
  if (next >= MAX_CONSECUTIVE_PUSH_FAILURES) {
    return { kind: "delete", reason: "evicted" };
  }
  return { kind: "increment", failureCount: next };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  origin: string | null;
  failureCount: number;
}

export interface PushSendSummary {
  status: "sent" | "skipped";
  reason?: string;
  subscriptions: number;
  attempted: number;
  accepted: number;
  failed: number;
}

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webPush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log("[PUSH] Web Push configured");
} else {
  console.log("[PUSH] Web Push disabled — missing VAPID keys");
}

/** Send push notification to all subscriptions of a user */
/**
 * Maps a push category to the "adjudicated surface" token that
 * notificationSuppressionReason treats as authored (skips the inbound-mail
 * noise heuristic). Only surfaces the system has already decided to interrupt
 * on qualify — the briefing (author-controlled body), email_urgent (the
 * firewall judge / URGENT classifier already tiered it PUSH), and github_urgent
 * (the firewall judge tiered a GitHub thread PUSH). Everything else stays
 * subject to the noise + housekeeping filters.
 */
export function authoredSurface(category: NotifCategory): "briefing" | "firewall" | null {
  if (category === "daily_briefing") return "briefing";
  if (category === "email_urgent") return "firewall";
  if (category === "github_urgent") return "firewall";
  // email_candidate is an explicitly firewall-decided interrupt (candidate
  // materials), not inbound noise — author it as a firewall surface like the
  // other urgent surfaces, else the noise heuristic can suppress it.
  if (category === "email_candidate") return "firewall";
  // meeting is a first-party calendar interrupt (a starting-in-N-min alert),
  // not inbound mail — author it so a summary that collides with a noise
  // keyword ("confirm your…", "sale") is not silently suppressed at the gate.
  if (category === "meeting") return "firewall";
  return null;
}

export async function sendPushNotification(
  userId: string,
  payload: {
    title: string;
    body: string;
    url?: string;
    notificationId?: string;
    // AttentionItem id, when the interrupt maps 1:1 to a firewall item.
    // Lets secondary channels (Telegram) attach tier-override buttons.
    attentionItemId?: string;
  },
  category: NotifCategory = "system",
): Promise<PushSendSummary> {
  // First line of defense: drop housekeeping + noise pushes BEFORE any
  // other check. Six other modules call this function (briefing,
  // reminder-scheduler, automation-scheduler, proactive-actions,
  // background, autonomous-agent). Patching each one is whack-a-mole;
  // the policy check belongs here.
  //
  // Anchored to the 2026-05-31 prod incident: 5 identical phone pushes
  // ("[Klorn] Action complete — mark read finished") from the LOW-risk
  // auto-exec path that PR #456's notify_user-tool guard did not cover.
  const suppression = notificationSuppressionReason({
    title: payload.title,
    message: payload.body,
    // category is a routing/preference dimension; we co-opt it as the
    // adjudicated-surface hint so content the system already decided to
    // interrupt on bypasses the inbound-mail noise heuristic.
    notificationType: authoredSurface(category),
  });
  if (suppression) {
    // Log the category, never payload.title — the title is "Klorn — {sender}"
    // for mail interrupts, i.e. a third party's identity + evidence of the
    // user's private correspondence, which must not reach stdout/log drains.
    console.log(`[PUSH] Suppressed (${suppression}) for ${userId} (${category})`);
    await recordSkipped(userId, payload.title, category, `policy_${suppression}`);
    return skipped(`policy_${suppression}`);
  }

  // Respect per-user category preferences and quiet hours. Quiet hours get
  // their own skipReason so PushDeliveryLog can tell "user opted out of this
  // category" apart from "user is asleep". Either way the browser stays
  // silent while the upstream Notification row keeps the event in the bell.
  // (The VAPID check runs later, after the Telegram send, so a
  // Telegram-only self-host without VAPID keys still gets interrupts.)
  const gate = await evaluateNotificationGate(userId, category);
  if (!gate.allowed) {
    console.log(`[PUSH] Suppressed (${gate.reason}) for ${userId} (${category})`);
    await recordSkipped(userId, payload.title, category, gate.reason);
    return skipped(gate.reason);
  }

  if (category === "agent_proposal") {
    const cooldownHit = await hasRecentAgentProposalPush(userId);
    if (cooldownHit) {
      console.log(`[PUSH] Suppressed agent proposal cooldown for ${userId} (${category})`);
      await recordSkipped(userId, payload.title, category, "agent_proposal_cooldown");
      return skipped("agent_proposal_cooldown");
    }
  }

  // Global per-user rate limit (Postgres-backed, survives deploys) — blocks
  // phone ring; DB notification is already persisted upstream so the bell
  // still surfaces this event.
  const rate = await recordPushAttempt(userId);
  if (!rate.allowed) {
    console.log(`[PUSH] Rate-limited for ${userId} (${category}): ${rate.reason}`);
    await recordSkipped(
      userId,
      payload.title,
      category,
      `rate_limited:${rate.reason ?? "unknown"}`,
    );
    return skipped("rate_limited");
  }

  // Secondary channel: Telegram (best-effort). Runs AFTER the shared gates
  // above so it inherits exactly the same suppression decisions as web push,
  // and BEFORE the VAPID check so a Telegram-only self-hoster (no VAPID keys,
  // no browser subscriptions) still gets PUSH-tier interrupts. Contained:
  // sendTelegramForPush never throws by design, and the .catch is a second
  // belt so a bug there can never fail the web-push path.
  await sendTelegramForPush(userId, payload, category).catch((err) => {
    // Defense-in-depth: sendTelegramForPush is designed never to throw and
    // logs/captures its own failures. If it ever does throw, this must not
    // sink the web-push path below — but don't swallow it silently either,
    // or a Telegram-only self-hoster loses every PUSH alert with no trace.
    console.warn(`[PUSH] Telegram secondary channel threw for ${userId}:`, err);
  });

  // Native mobile channels (Capacitor shell): FCM for Android, APNs for iOS.
  // Best-effort and in ADDITION to web push, running after the shared gates
  // above so they inherit the same suppression/quiet-hours/rate-limit decisions.
  // Contained like Telegram: a device-channel fault must never sink web push.
  // Each is a no-op (logged skip) when its credentials/tokens are absent.
  // FCM (Android) and APNs (iOS) are independent — run in parallel. Fire them
  // WITHOUT awaiting so a slow/stalled APNs http2 handshake (fresh session +
  // 10s per-request timeout) never stacks latency onto the primary web-push
  // path below. Each has its own .catch, so no unhandled rejection escapes.
  void Promise.all([
    sendDevicePush(userId, payload, category).catch((err) => {
      console.warn(`[PUSH] FCM device channel threw for ${userId}:`, err);
    }),
    sendApnsPush(userId, payload, category).catch((err) => {
      console.warn(`[PUSH] APNs device channel threw for ${userId}:`, err);
    }),
  ]);

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.log(`[PUSH] Skipped — VAPID keys not configured`);
    await recordSkipped(userId, payload.title, category, "missing_vapid_keys");
    return skipped("missing_vapid_keys");
  }

  const allSubscriptions = (await prisma.pushSubscription.findMany({
    where: { userId },
  })) as PushSubscriptionRow[];

  // Skip subs whose SW origin is no longer in the allowlist. Their SW would
  // openWindow() to a domain we no longer serve. NULL origins are pre-migration
  // rows of unknown provenance — treat as stale and let cleanup-stale-push-subs
  // delete them.
  const subscriptions = allSubscriptions.filter((sub) => isAllowedPushOrigin(sub.origin));
  const droppedForOrigin = allSubscriptions.length - subscriptions.length;
  if (droppedForOrigin > 0) {
    console.log(
      `[PUSH] Skipping ${droppedForOrigin} sub(s) for ${userId} with disallowed/missing origin`,
    );
  }

  if (subscriptions.length === 0) {
    console.log(`[PUSH] No push subscriptions for user ${userId} — browser push skipped`);
    await recordSkipped(userId, payload.title, category, "no_subscriptions");
    return skipped("no_subscriptions");
  }
  // Category only, never payload.title (== "Klorn — {sender}" for mail) — this
  // fires on every successful send, so it is the highest-volume leak of the
  // three suppression-path lines already redacted above.
  console.log(
    `[PUSH] Sending to ${subscriptions.length} subscription(s) for ${userId} (${category})`,
  );

  // Fan out with bounded concurrency (same Semaphore util gmail-fetch.ts uses).
  // sem.all preserves per-thunk isolation as long as no thunk throws — and
  // deliverToSubscription is total (it catches per-attempt), so one sub's
  // failure or retry-sleep never sinks or blocks the others, mirroring the old
  // serial loop's `continue`.
  const sem = new Semaphore(PUSH_FANOUT_CONCURRENCY);
  const results = await sem.all(
    subscriptions.map((sub) => () => deliverToSubscription(userId, sub, payload, category)),
  );
  const attempted = results.filter((r) => r.attempted).length;
  const accepted = results.filter((r) => r.delivered).length;
  const failed = attempted - accepted;

  console.log(`[PUSH] Sent ${accepted}/${attempted} push notifications successfully`);
  return {
    status: "sent",
    subscriptions: subscriptions.length,
    attempted,
    accepted,
    failed,
  };
}

/**
 * Deliver one push to one subscription: unsafe-endpoint skip, delivery-attempt
 * log, bounded in-process retry, accept/fail marking, failure-count reset on
 * recover, and budgeted eviction (410/404 delete + atomic increment + threshold
 * evict). Total by design — never throws — so a bounded-concurrency fan-out over
 * these stays failure-isolated like the old serial loop's `continue`.
 *
 * (Slightly over the 50-line guideline: this is the extracted per-subscription
 * body kept verbatim rather than over-split, to preserve behavior exactly.)
 */
async function deliverToSubscription(
  userId: string,
  sub: PushSubscriptionRow,
  payload: {
    title: string;
    body: string;
    url?: string;
    notificationId?: string;
    attentionItemId?: string;
  },
  category: NotifCategory,
): Promise<{ attempted: boolean; delivered: boolean }> {
  if (!isSafePushEndpoint(sub.endpoint)) {
    await recordSkipped(userId, payload.title, category, "unsafe_endpoint");
    return { attempted: false, delivered: false };
  }
  const deliveryId = await createPushDeliveryAttempt({
    userId,
    subscriptionId: sub.id,
    endpoint: sub.endpoint,
    notificationId: payload.notificationId ?? null,
    category,
    title: payload.title,
  });

  // Stable, ≤32-char, URL/filename-safe topic derived from deliveryId. Constant
  // across this subscription's retries, so after an AMBIGUOUS failure (e.g. a
  // network timeout where the message was actually delivered) the push service
  // REPLACES the still-pending message instead of stacking a duplicate. This
  // only dedupes within the service's pending-delivery window — not a full
  // guarantee — and complements the app-level dedup done elsewhere.
  const topic = crypto.createHash("sha256").update(deliveryId).digest("base64url").slice(0, 32);

  let lastStatusCode: number | undefined;
  let lastBody: string | undefined;
  let lastError: unknown;
  let delivered = false;
  const maxAttempts = 1 + PUSH_RETRY_DELAYS_MS.length;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await webPush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        JSON.stringify({
          ...payload,
          ...tierOverrideFields(userId, payload.attentionItemId),
          deliveryId,
          receiptUrl: pushReceiptUrl(deliveryId),
        }),
        { topic },
      );
      delivered = true;
      if (attempt > 0) {
        console.log(`[PUSH] Recovered on retry ${attempt} for subscription ${sub.id}`);
      }
      break;
    } catch (err) {
      lastError = err;
      lastStatusCode = (err as { statusCode?: number })?.statusCode;
      lastBody = (err as { body?: string })?.body;
      // Permanent failures: stop retrying so we can clean up below.
      if (!shouldRetryPushError(lastStatusCode)) break;
      const nextDelay = PUSH_RETRY_DELAYS_MS[attempt];
      if (nextDelay === undefined) break;
      console.warn(
        `[PUSH] Transient failure status=${lastStatusCode ?? "network"} for ${sub.id}; retrying in ${nextDelay}ms`,
      );
      await sleep(nextDelay);
    }
  }

  if (delivered) {
    await markPushAccepted(deliveryId);
    // Recovered: clear the consecutive-failure tally so a sub that had a
    // transient bad spell isn't evicted on a later push.
    if (sub.failureCount > 0) {
      await prisma.pushSubscription.update({
        where: { id: sub.id },
        data: { failureCount: 0, lastFailedAt: null },
      });
    }
    return { attempted: true, delivered: true };
  }

  await markPushFailed(deliveryId, { statusCode: lastStatusCode, body: lastBody });
  console.error(
    `[PUSH] Failed to send to subscription ${sub.id} after ${maxAttempts} attempts: status=${lastStatusCode}, body=${lastBody}, error=${lastError}`,
  );
  // Budgeted eviction: 410/404 → delete now; otherwise count the consecutive
  // failure and delete once it crosses the threshold (stops a dead endpoint
  // from burning the retry budget every tick).
  const action = decidePushFailureAction(sub.failureCount, lastStatusCode);
  if (action.kind === "delete") {
    await prisma.pushSubscription.delete({ where: { id: sub.id } });
    console.log(
      `[PUSH] Removed ${action.reason} subscription ${sub.id} (failureCount=${sub.failureCount})`,
    );
  } else {
    // Increment ATOMICALLY — sub.failureCount is from a findMany snapshot, so
    // two pushes to the same sub in one tick would otherwise both write the
    // same absolute value and lose a failure. Re-check the threshold on the
    // fresh value so eviction can't be delayed by a stale read.
    const updated = await prisma.pushSubscription.update({
      where: { id: sub.id },
      data: { failureCount: { increment: 1 }, lastFailedAt: new Date() },
      select: { failureCount: true },
    });
    if (updated.failureCount >= MAX_CONSECUTIVE_PUSH_FAILURES) {
      await prisma.pushSubscription.delete({ where: { id: sub.id } });
      console.log(
        `[PUSH] Evicted subscription ${sub.id} after ${updated.failureCount} consecutive failures`,
      );
    }
  }
  return { attempted: true, delivered: false };
}

/** Get the public VAPID key for client-side subscription */
export function getVapidPublicKey(): string {
  return VAPID_PUBLIC_KEY;
}

function skipped(reason: string): PushSendSummary {
  return { status: "skipped", reason, subscriptions: 0, attempted: 0, accepted: 0, failed: 0 };
}

async function recordSkipped(
  userId: string,
  title: string,
  category: NotifCategory,
  skipReason: string,
): Promise<void> {
  await createSkippedPushDelivery({ userId, category, title, skipReason });
}

function pushReceiptUrl(deliveryId: string): string | null {
  if (!PUSH_RECEIPT_BASE_URL) return null;
  return `${PUSH_RECEIPT_BASE_URL.replace(/\/+$/, "")}/api/notifications/push/receipts/${deliveryId}`;
}

// One-tap notification action buttons for a firewall interrupt: "Later" defers
// to QUEUE, "Mute" silences (SILENT). Both are reversible — a notification can
// never escalate to PUSH/AUTO. The service worker reads these from the payload.
const TIER_OVERRIDE_ACTIONS = [
  { action: "queue", title: "Later" },
  { action: "silent", title: "Mute" },
] as const;

function tierOverrideUrl(): string | null {
  if (!PUSH_RECEIPT_BASE_URL) return null;
  return `${PUSH_RECEIPT_BASE_URL.replace(/\/+$/, "")}/api/notifications/push/tier-override`;
}

/**
 * One-tap retier fields for a firewall push: notification action buttons, a
 * capability token scoped to this (user, item), and the endpoint to POST it to.
 * Returns {} when the push is not a 1:1 firewall item (no attentionItemId) or
 * the base URL is unset — so a non-firewall push's payload is byte-identical to
 * before and never carries override buttons.
 */
function tierOverrideFields(
  userId: string,
  attentionItemId: string | undefined,
): Record<string, unknown> {
  const url = tierOverrideUrl();
  if (!attentionItemId || !url) return {};
  return {
    actions: TIER_OVERRIDE_ACTIONS,
    overrideUrl: url,
    overrideToken: mintTierOverrideToken(userId, attentionItemId),
  };
}

async function hasRecentAgentProposalPush(userId: string): Promise<boolean> {
  const since = new Date(Date.now() - AGENT_PROPOSAL_PUSH_COOLDOWN_HOURS * 60 * 60 * 1000);
  const recent = await prisma.pushDeliveryLog.findFirst({
    where: {
      userId,
      category: "agent_proposal",
      status: { in: ["PENDING", "ACCEPTED"] },
      createdAt: { gte: since },
    },
    select: { id: true },
  });
  return !!recent;
}
